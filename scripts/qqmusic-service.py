#!/usr/bin/env python3
"""Small localhost-only QQ Music sidecar.

The QQMusicApi SDK is intentionally kept behind this process boundary.  The
web app receives only typed metadata, a QR image, and an opaque short-lived
QR session key; the SDK Credential never crosses the boundary.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import secrets
import sys
import time
from collections import deque
from dataclasses import dataclass
from hmac import compare_digest
from pathlib import Path
from typing import Any

from qqmusic_api import Client, Credential
from qqmusic_api.core.exceptions import BaseApiException
from qqmusic_api.models.login import QR, QRLoginType
from qqmusic_api.modules.song import SongFileInfo, SongFileType


HOST = os.environ.get("QQMUSIC_HOST", "127.0.0.1")
PORT = int(os.environ.get("QQMUSIC_PORT", "4321"))
MAX_HEADER_BYTES = 16 * 1024
MAX_BODY_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
REQUEST_HEADER_TIMEOUT_SECONDS = 5
SDK_TIMEOUT_SECONDS = 30
QR_TTL_SECONDS = 180
QR_TERMINAL_TTL_SECONDS = 30
MAX_QR_SESSIONS = 8
QR_CREATE_WINDOW_SECONDS = 60
MAX_QR_CREATES_PER_WINDOW = 12
QIMEI_COMPAT_Q36 = "6c9d3cd110abca9b16311cee10001e717614"
DEFAULT_CREDENTIAL_PATH = Path.home() / "Library" / "Application Support" / "OneRadio" / "qqmusic-credential.json"
CREDENTIAL_PATH = Path(os.environ.get("QQMUSIC_CREDENTIAL_PATH", str(DEFAULT_CREDENTIAL_PATH))).expanduser()
SIDECAR_TOKEN = os.environ.get("QQMUSIC_SIDECAR_TOKEN", "").strip() or secrets.token_urlsafe(32)
ALLOWED_ORIGINS = frozenset(
    origin.strip()
    for origin in os.environ.get(
        "QQMUSIC_ALLOWED_ORIGINS",
        "http://127.0.0.1:5173,http://localhost:5173",
    ).split(",")
    if origin.strip()
)

logging.basicConfig(level=os.environ.get("QQMUSIC_LOG_LEVEL", "WARNING"), format="%(levelname)s %(message)s")
LOGGER = logging.getLogger("one-radio.qqmusic")


@dataclass
class QrSession:
    login_type: QRLoginType
    qr: QR
    expires_at: float
    terminal_code: int | None = None
    state_code: int = 801
    watcher: asyncio.Task[None] | None = None


class HttpRequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _credential_has_login(credential: Credential | None) -> bool:
    return bool(credential and credential.musicid and credential.musickey)


def _load_credential() -> Credential:
    try:
        if not CREDENTIAL_PATH.is_file() or CREDENTIAL_PATH.is_symlink():
            return Credential()
        if CREDENTIAL_PATH.stat().st_uid != os.getuid():
            return Credential()
        os.chmod(CREDENTIAL_PATH, 0o600)
        return Credential.model_validate_json(CREDENTIAL_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return Credential()


def _persist_credential(credential: Credential) -> None:
    if not _credential_has_login(credential):
        raise ValueError("QQ Music credential is empty")
    directory = CREDENTIAL_PATH.parent
    if directory.is_symlink():
        raise PermissionError("QQ Music credential directory must not be a symlink")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory_stat = directory.stat()
    if directory_stat.st_uid != os.getuid():
        raise PermissionError("QQ Music credential directory is not owned by the current user")
    if directory_stat.st_mode & 0o077:
        os.chmod(directory, 0o700)
    temporary = directory / f".{CREDENTIAL_PATH.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp"
    try:
        temporary.write_text(credential.model_dump_json(by_alias=True), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, CREDENTIAL_PATH)
        os.chmod(CREDENTIAL_PATH, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _delete_credential() -> None:
    try:
        if CREDENTIAL_PATH.is_symlink():
            raise PermissionError("QQ Music credential path must not be a symlink")
        if CREDENTIAL_PATH.exists() and CREDENTIAL_PATH.stat().st_uid != os.getuid():
            raise PermissionError("QQ Music credential must be owned by the current user")
        CREDENTIAL_PATH.unlink(missing_ok=True)
    except OSError as error:
        raise PermissionError("QQ Music credential could not be removed") from error


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    return str(value)


def _get(value: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(value, dict) and name in value:
            return value[name]
        if hasattr(value, name):
            return getattr(value, name)
    return default


def _as_id(value: Any) -> str:
    try:
        result = str(value).strip()
    except Exception:
        result = ""
    return result if result.isdigit() and int(result) > 0 else ""


def _serialize_song(song: Any) -> dict[str, Any]:
    artists_value = _get(song, "singer", "artists", "ar", default=[])
    if not isinstance(artists_value, (list, tuple)):
        artists_value = []
    artists = []
    for artist in artists_value:
        artist_id = _as_id(_get(artist, "id", "singer_id", "singerID", default=""))
        artist_name = str(_get(artist, "name", "title", "singer_name", "singerName", default="") or "").strip()
        if artist_name:
            artists.append({"id": artist_id or artist_name, "name": artist_name})
    album_value = _get(song, "album", "al", default={})
    album_id = _as_id(_get(album_value, "id", "albumID", default=""))
    album_name = str(_get(album_value, "name", "title", "albumName", default="") or "").strip()
    album_mid = str(_get(album_value, "mid", "albumMid", "albummid", "pmid", default="") or "").strip()
    title = str(_get(song, "name", "title", "title_main", default="") or "").strip()
    mid = str(_get(song, "mid", "songmid", default="") or "").strip()
    song_id = _as_id(_get(song, "id", "songid", default=""))
    if not song_id and mid:
        # MID is stable for QQ playback and is safe to use as the opaque id in
        # the local app when the upstream result omits a numeric song id.
        song_id = mid
    duration = _get(song, "interval", "duration", default=0)
    try:
        duration_ms = max(0, int(float(duration) * 1000))
    except (TypeError, ValueError):
        duration_ms = 0
    public_date = str(_get(song, "time_public", "publish_date", default="") or "")
    release_year = None
    if len(public_date) >= 4 and public_date[:4].isdigit():
        year = int(public_date[:4])
        if 1900 <= year <= 2200:
            release_year = year
    result: dict[str, Any] = {
        "id": song_id,
        "title": title or mid,
        "artists": artists,
        "album": {
            "id": album_id or album_name or "0",
            "name": album_name or "未知专辑",
            **({"coverUrl": f"https://y.gtimg.cn/music/photo_new/T002R500x500M000{album_mid}.jpg"}
               if album_mid.isalnum() else {}),
        },
        "durationMs": duration_ms,
        "mid": mid,
        "songType": int(_get(song, "type", "song_type", default=0) or 0),
        "mediaMid": str(_get(_get(song, "file", default={}), "media_mid", "mediaMid", default="") or ""),
    }
    if release_year is not None:
        result["releaseYear"] = release_year
    return result


def _serialize_playlist(playlist: Any) -> dict[str, Any]:
    directory_id = _as_id(_get(playlist, "dirid", "dirId", default=""))
    playlist_id = _as_id(_get(playlist, "id", "tid", "dissid", default=""))
    owner_uid = str(_get(playlist, "uin", "musicid", default="") or "").strip()
    result = {
        "id": playlist_id or directory_id,
        "dirId": directory_id,
        "name": str(_get(playlist, "title", "name", "dissname", "dirName", default="") or "").strip(),
        "description": str(_get(playlist, "desc", "description", default="") or "") or None,
        "trackCount": max(0, int(_get(playlist, "songnum", "songNum", "song_cnt", default=0) or 0)),
    }
    if playlist_id:
        result["tid"] = playlist_id
    if owner_uid:
        result["ownerUid"] = owner_uid
    return result


def _credential_payload(credential: Credential) -> dict[str, Any]:
    # Used internally for persisted state only.  This function must never be
    # returned from a route.
    return credential.model_dump(by_alias=True)


class QqMusicService:
    def __init__(self) -> None:
        self.credential = _load_credential()
        self.client = Client(credential=self.credential)
        self.qr_sessions: dict[str, QrSession] = {}
        self.qr_create_times: deque[float] = deque()
        self.qr_create_lock = asyncio.Lock()
        self.playlist_mutation_lock = asyncio.Lock()
        self.health_lock = asyncio.Lock()
        self.last_health_check = 0.0
        self.authenticated = _credential_has_login(self.credential)
        self.last_error: str | None = None

    async def close(self) -> None:
        watchers = [session.watcher for session in self.qr_sessions.values() if session.watcher is not None]
        for watcher in watchers:
            watcher.cancel()
        if watchers:
            await asyncio.gather(*watchers, return_exceptions=True)
        await self.client.close()

    async def logout(self) -> dict[str, Any]:
        watchers = [session.watcher for session in self.qr_sessions.values() if session.watcher is not None]
        for watcher in watchers:
            watcher.cancel()
        if watchers:
            await asyncio.gather(*watchers, return_exceptions=True)
        self.qr_sessions.clear()
        _delete_credential()
        previous_client = self.client
        self.credential = Credential()
        self.client = Client(credential=self.credential)
        self.authenticated = False
        self.last_health_check = 0.0
        self.last_error = None
        await previous_client.close()
        return self._status("blocked_by_auth")

    async def health(self) -> dict[str, Any]:
        if not _credential_has_login(self.credential):
            self.authenticated = False
            return self._status("blocked_by_auth")
        now = time.monotonic()
        if self.authenticated and now - self.last_health_check < 30:
            return self._status("ready")
        async with self.health_lock:
            now = time.monotonic()
            if self.authenticated and now - self.last_health_check < 30:
                return self._status("ready")
            try:
                try:
                    expired = await self.client.login.check_expired(self.credential)
                except RuntimeError as error:
                    if "QIMEI response missing required fields" not in str(error):
                        raise
                    await self._apply_qimei_compatibility()
                    expired = await self.client.login.check_expired(self.credential)
                if expired:
                    self.credential = await self.client.login.refresh_credential(self.credential)
                    _persist_credential(self.credential)
                    self.client.credential = self.credential
                self.authenticated = _credential_has_login(self.credential)
                self.last_health_check = time.monotonic()
                self.last_error = None
            except Exception as error:  # SDK errors are intentionally redacted at the boundary.
                self.authenticated = False
                self.last_health_check = 0.0
                self.last_error = type(error).__name__
        return self._status("ready" if self.authenticated else "unavailable")

    def _status(self, state: str) -> dict[str, Any]:
        return {
            "provider": "qqmusic-api",
            "configured": True,
            "baseUrl": f"http://{HOST}:{PORT}",
            "timeoutMs": 8_000,
            "authenticated": self.authenticated,
            "persistentLogin": CREDENTIAL_PATH.is_file(),
            "state": state,
            "credentialPathConfigured": True,
        }

    async def create_qr(self, login_type: str) -> dict[str, Any]:
        # Serialize the upstream QR request with session accounting.  Without
        # this lock, concurrent requests can all observe an empty map while
        # awaiting the SDK and exceed the hard session cap on completion.
        async with self.qr_create_lock:
            selected = _qr_type(login_type)
            now = time.monotonic()
            self._prune_qr_sessions(now)
            while self.qr_create_times and now - self.qr_create_times[0] >= QR_CREATE_WINDOW_SECONDS:
                self.qr_create_times.popleft()
            if len(self.qr_create_times) >= MAX_QR_CREATES_PER_WINDOW:
                raise HttpRequestError(429, "QR login rate limit reached")
            if len(self.qr_sessions) >= MAX_QR_SESSIONS:
                raise HttpRequestError(429, "too many QR login sessions")
            self.qr_create_times.append(now)
            # A new QR is the active login attempt.  This prevents an old QR
            # that is completed out of order from replacing a newer session.
            for session in self.qr_sessions.values():
                if session.watcher is not None:
                    session.watcher.cancel()
            self.qr_sessions.clear()
            qr = await self._create_qr(selected)
            key = secrets.token_urlsafe(32)
            session = QrSession(selected, qr, time.time() + QR_TTL_SECONDS)
            self.qr_sessions[key] = session
            if selected == QRLoginType.MOBILE:
                session.watcher = asyncio.create_task(self._watch_mobile_qr(key, session))
            data = base64.b64encode(qr.data).decode("ascii")
            return {
                "key": key,
                "loginType": selected.value,
                "qrImageDataUrl": f"data:{qr.mimetype};base64,{data}",
                "expiresIn": QR_TTL_SECONDS,
            }

    async def _create_qr(self, selected: QRLoginType) -> QR:
        try:
            return await self.client.login.get_qrcode(selected)
        except RuntimeError as error:
            if selected != QRLoginType.MOBILE or "QIMEI response missing required fields" not in str(error):
                raise
            await self._apply_qimei_compatibility()
            return await self.client.login.get_qrcode(selected)

    async def _apply_qimei_compatibility(self) -> None:
        # SDK 0.7.2 removed the fallback still present in the upstream
        # implementation. Restore that compatibility value locally so both
        # a persisted login and the QQ Music mobile QR endpoint survive a
        # sidecar restart when the QIMEI service returns an empty payload.
        manager = self.client._context._qimei_manager
        q16 = QIMEI_COMPAT_Q36[:16]
        manager._cache = {"q16": q16, "q36": QIMEI_COMPAT_Q36}
        await manager._device_store.apply_qimei(q16, QIMEI_COMPAT_Q36)

    async def check_qr(self, key: str, login_type: str | None = None) -> dict[str, Any]:
        self._prune_qr_sessions(time.monotonic())
        session = self.qr_sessions.get(key)
        if session is None:
            return {"code": 800, "state": "expired", "loginType": login_type or "mobile"}
        selected = _qr_type(login_type or session.login_type.value)
        if selected != session.login_type:
            return {"code": 800, "state": "expired", "loginType": session.login_type.value}
        if time.time() >= session.expires_at:
            self.qr_sessions.pop(key, None)
            return {"code": 800, "state": "expired", "loginType": session.login_type.value}
        if session.terminal_code is not None:
            return {"code": session.terminal_code, "state": "authorized", "loginType": session.login_type.value}
        if session.login_type == QRLoginType.MOBILE:
            return {
                "code": session.state_code,
                "state": _qr_state(session.state_code),
                "loginType": session.login_type.value,
            }
        result = await self.client.login.check_qrcode(session.qr)
        if self.qr_sessions.get(key) is not session:
            return {"code": 800, "state": "expired", "loginType": session.login_type.value}
        code, state = self._apply_qr_result(key, session, result)
        return {"code": code, "state": state, "loginType": session.login_type.value}

    async def _watch_mobile_qr(self, key: str, session: QrSession) -> None:
        deadline = time.monotonic() + QR_TTL_SECONDS
        while self.qr_sessions.get(key) is session and time.monotonic() < deadline:
            try:
                async for result in self.client.login.checking_mobile_qrcode(session.qr, deadline=deadline):
                    if self.qr_sessions.get(key) is not session:
                        return
                    code, _state = self._apply_qr_result(key, session, result)
                    if code in {800, 803}:
                        return
                if session.state_code in {800, 803}:
                    return
            except asyncio.CancelledError:
                raise
            except Exception as error:
                LOGGER.warning("QQ Music mobile QR watcher failed: %s", type(error).__name__)
            await asyncio.sleep(1)
        if self.qr_sessions.get(key) is session:
            session.state_code = 800

    def _apply_qr_result(self, key: str, session: QrSession, result: Any) -> tuple[int, str]:
        if self.qr_sessions.get(key) is not session:
            return 800, "expired"
        event_map = {
            "DONE": 803,
            "SCAN": 801,
            "CONF": 802,
            "TIMEOUT": 800,
            "REFUSE": 800,
        }
        code = event_map.get(result.event.name, 801)
        if code == 803:
            if result.credential is None:
                return 801, "waiting_scan"
            self.credential = result.credential
            self.client.credential = self.credential
            _persist_credential(self.credential)
            self.authenticated = True
            self.last_health_check = time.monotonic()
            session.terminal_code = 803
            session.expires_at = time.time() + QR_TERMINAL_TTL_SECONDS
        session.state_code = code
        return code, _qr_state(code)

    def _prune_qr_sessions(self, now: float) -> None:
        current = time.time()
        expired = [key for key, session in self.qr_sessions.items() if current >= session.expires_at]
        for key in expired:
            session = self.qr_sessions.pop(key, None)
            if session is not None and session.watcher is not None:
                session.watcher.cancel()
        while self.qr_create_times and now - self.qr_create_times[0] >= QR_CREATE_WINDOW_SECONDS:
            self.qr_create_times.popleft()

    async def require_auth(self) -> Credential:
        status = await self.health()
        if status["authenticated"] is not True:
            raise PermissionError("QQ Music login is required")
        return self.credential

    async def account(self) -> dict[str, Any]:
        credential = await self.require_auth()
        return {"uid": str(credential.musicid), "nickname": None}

    async def search(self, keyword: str, limit: int = 20, offset: int = 0) -> dict[str, Any]:
        if not keyword.strip():
            raise ValueError("keyword is required")
        await self.require_auth()
        page = offset // max(1, limit) + 1
        result = await self.client.search.search_by_type(keyword.strip(), num=limit, page=page)
        songs = [_serialize_song(song) for song in (getattr(result, "song", None) or [])]
        return {"songs": songs, "total": len(songs)}

    async def playlists(self, limit: int = 100, offset: int = 0) -> dict[str, Any]:
        credential = await self.require_auth()
        created = await self.client.user.get_created_songlist(credential.musicid, credential=credential)
        if not bool(created.finished):
            raise HttpRequestError(503, "QQ Music playlist inventory is incomplete")
        favorites = await self.client.user.get_fav_songlist(
            credential.encrypt_uin,
            page=1,
            num=100,
            credential=credential,
        )
        if bool(favorites.hasmore):
            raise HttpRequestError(503, "QQ Music favorite playlist inventory is incomplete")
        page_size = max(1, min(100, limit))
        page_offset = max(0, offset)
        combined = [*list(created.playlists or []), *list(favorites.playlists or [])]
        playlists_by_id = {
            item["id"]: item
            for item in (_serialize_playlist(value) for value in combined)
            if item["id"]
        }
        playlists = list(playlists_by_id.values())
        page = playlists[page_offset:page_offset + page_size]
        return {
            "playlists": page,
            "more": page_offset + len(page) < len(playlists),
        }

    async def liked(self, limit: int = 100) -> dict[str, Any]:
        credential = await self.require_auth()
        requested = max(1, min(500, limit))
        songs: list[Any] = []
        for page in range(1, 6):
            page_size = min(100, requested - len(songs))
            if page_size <= 0:
                break
            result = await self.client.user.get_fav_song(
                euin=credential.encrypt_uin,
                page=page,
                num=page_size,
                credential=credential,
            )
            page_songs = list(result.songs or [])
            songs.extend(page_songs)
            if not bool(result.hasmore) or len(page_songs) < page_size:
                break
        return {"songs": [_serialize_song(song) for song in songs[:requested]]}

    async def liked_contains(self, song_id: str) -> bool:
        liked = await self.liked(500)
        return any(isinstance(song, dict) and str(song.get("id", "")) == song_id for song in liked["songs"])

    async def recent(self, _limit: int = 100) -> dict[str, Any]:
        """Return recent playback records when the upstream exposes them.

        QQMusicApi 0.7.x does not expose a stable recent-play endpoint.  Keep
        this contract explicit and empty instead of presenting the liked list
        as listening history.
        """
        await self.require_auth()
        return {"records": []}

    async def history(self, _period: str = "all") -> dict[str, Any]:
        await self.require_auth()
        return {"records": []}

    async def recommendations(self) -> dict[str, Any]:
        credential = await self.require_auth()
        result = await self.client.recommend.get_guess_recommend(credential=credential)
        songs = getattr(result, "songs", None) or getattr(result, "tracks", None) or []
        return {"songs": [_serialize_song(song) for song in songs]}

    async def playlist_detail(self, playlist_id: str) -> dict[str, Any]:
        await self.require_auth()
        page_size = 100
        songs: list[Any] = []
        result = None
        for page in range(1, 4):
            result = await self.client.songlist.get_detail(int(playlist_id), num=page_size, page=page)
            page_songs = list(result.songs or [])
            songs.extend(page_songs)
            total = int(getattr(result, "total", 0) or 0)
            if len(page_songs) < page_size or (total > 0 and len(songs) >= total):
                break
        if result is None:
            raise RuntimeError("QQ Music playlist detail returned no result")
        info = _serialize_playlist(getattr(result, "info", {}))
        info["id"] = playlist_id
        info["tracks"] = [_serialize_song(song) for song in songs]
        info["trackCount"] = max(info["trackCount"], int(getattr(result, "total", 0) or 0))
        return info

    async def song_detail(self, song_id: str) -> list[dict[str, Any]]:
        await self.require_auth()
        result = await self.client.song.query_song([_song_query(song_id)])
        return [_serialize_song(song) for song in (result.tracks or [])]

    async def similar(self, song_id: str) -> list[dict[str, Any]]:
        await self.require_auth()
        result = await self.client.song.get_similar_song(int(song_id))
        songs: list[dict[str, Any]] = []
        for group in getattr(result, "song", None) or []:
            songs.extend(_serialize_song(song) for song in (getattr(group, "song", None) or []))
        return songs

    async def song_url(self, song_id: str) -> dict[str, Any]:
        credential = await self.require_auth()
        songs = await self.client.song.query_song([_song_query(song_id)])
        if not songs.tracks:
            return {"id": song_id, "url": None, "durationMs": None}
        song = songs.tracks[0]
        mid = str(getattr(song, "mid", "") or "")
        if not mid:
            return {"id": song_id, "url": None, "durationMs": _serialize_song(song)["durationMs"]}
        urls = await self.client.song.get_song_urls(
            [SongFileInfo(mid=mid, song_type=int(getattr(song, "type", 0) or 0), media_mid=str(getattr(getattr(song, "file", None), "media_mid", "") or ""))],
            file_type=SongFileType.MP3_128,
            credential=credential,
        )
        if not urls.data:
            return {"id": song_id, "url": None, "durationMs": _serialize_song(song)["durationMs"]}
        item = urls.data[0]
        authorized = item.result == 0
        url = await self._resolve_url(item.purl, item.vkey) if authorized else None
        return {
            "id": song_id,
            "url": url,
            "durationMs": _serialize_song(song)["durationMs"],
            "format": "mp3",
            "complete": authorized and url is not None,
            "authorizationCode": item.result,
        }

    async def _resolve_url(self, purl: str, vkey: str) -> str | None:
        if not purl or not vkey:
            return None
        dispatch = await self.client.song.get_cdn_dispatch()
        for root in getattr(dispatch, "sip", None) or []:
            candidate = str(root).rstrip("/") + "/" + str(purl).lstrip("/")
            if "?" in candidate:
                candidate += "&vkey=" + vkey
            else:
                candidate += "?vkey=" + vkey
            if candidate.startswith(("https://", "http://")):
                return candidate
        return None

    @staticmethod
    def _assert_expected_account(credential: Credential, expected_uid: str) -> None:
        if str(getattr(credential, "musicid", "") or "") != expected_uid:
            raise PermissionError("QQ Music account changed")

    async def create_playlist(self, name: str, expected_uid: str) -> dict[str, Any]:
        credential = await self.require_auth()
        self._assert_expected_account(credential, expected_uid)
        result = await self.client.songlist.create(name.strip(), credential=credential)
        return {
            "id": str(getattr(result, "id", 0) or ""),
            "dirId": str(getattr(result, "dirid", 0) or ""),
            "name": name.strip(),
        }

    async def delete_playlist(self, playlist_id: str, dir_id: str, expected_uid: str) -> dict[str, Any]:
        credential = await self.require_auth()
        self._assert_expected_account(credential, expected_uid)
        result = await self.client.songlist.delete(int(dir_id), credential=credential)
        returned = _as_id(_get(result, "dirid", "dirId", "id", default=result if isinstance(result, (str, int)) else ""))
        already_deleted = returned == "0"
        return {
            "playlistId": playlist_id,
            "dirId": dir_id,
            "deleted": bool(returned) and not already_deleted,
            "alreadyDeleted": already_deleted,
        }

    async def add_songs(self, playlist_id: str, dir_id: str, track_ids: list[str], expected_uid: str) -> dict[str, Any]:
        credential = await self.require_auth()
        self._assert_expected_account(credential, expected_uid)
        songs = await self.client.song.query_song([_song_query(track_id) for track_id in track_ids])
        info = [(int(song.id), int(getattr(song, "type", 0) or 0)) for song in songs.tracks]
        if not info:
            raise ValueError("no valid tracks")
        async with self.playlist_mutation_lock:
            current = await self.client.songlist.get_detail(int(playlist_id), num=300, page=1)
            existing_ids = {int(song.id) for song in (current.songs or [])}
            missing_info = [(song_id, song_type) for song_id, song_type in info if song_id not in existing_ids]
            ok = not missing_info or await self.client.songlist.add_songs(
                int(dir_id),
                missing_info,
                tid=int(playlist_id),
                credential=credential,
            )
        if not ok:
            raise RuntimeError("QQ Music rejected playlist update")
        return {"playlistId": playlist_id, "trackIds": [str(song_id) for song_id, _song_type in info]}

    async def replace_songs(self, playlist_id: str, dir_id: str, track_ids: list[str], expected_uid: str) -> dict[str, Any]:
        credential = await self.require_auth()
        self._assert_expected_account(credential, expected_uid)
        songs = await self.client.song.query_song([_song_query(track_id) for track_id in track_ids])
        info = [(int(song.id), int(getattr(song, "type", 0) or 0)) for song in songs.tracks]
        if [str(song_id) for song_id, _song_type in info] != track_ids:
            raise ValueError("some replacement tracks are invalid")
        async with self.playlist_mutation_lock:
            current = await self.client.songlist.get_detail(int(playlist_id), num=300, page=1)
            current_info = [
                (int(song.id), int(getattr(song, "type", 0) or 0))
                for song in (current.songs or [])
            ]
            if current_info:
                removed = await self.client.songlist.del_songs(int(dir_id), current_info, tid=int(playlist_id), credential=credential)
                if not removed:
                    raise RuntimeError("QQ Music rejected playlist reset")
            try:
                added = await self.client.songlist.add_songs(int(dir_id), info, tid=int(playlist_id), credential=credential)
                if not added:
                    raise RuntimeError("QQ Music rejected playlist replacement")
            except Exception:
                if current_info:
                    restored = await self.client.songlist.add_songs(
                        int(dir_id),
                        list(reversed(current_info)),
                        tid=int(playlist_id),
                        credential=credential,
                    )
                    if not restored:
                        raise RuntimeError("QQ Music replacement and rollback both failed")
                raise
        return {"playlistId": playlist_id, "trackIds": [str(song_id) for song_id, _song_type in info]}

    async def set_song_liked(self, song_id: str, liked: bool, song_type: int, expected_uid: str) -> dict[str, Any]:
        credential = await self.require_auth()
        self._assert_expected_account(credential, expected_uid)
        if not song_id.isdigit() or int(song_id) <= 0:
            raise ValueError("song id must be a positive numeric string")
        if song_type < 0:
            raise ValueError("songType must be a non-negative integer")
        song_info = [(int(song_id), int(song_type))]
        async with self.playlist_mutation_lock:
            changed = await (
                self.client.songlist.like_song(song_info, credential=credential)
                if liked
                else self.client.songlist.unlike_song(song_info, credential=credential)
            )
        if not changed:
            confirmed = await self.liked_contains(song_id)
            if confirmed != liked:
                raise RuntimeError("QQ Music rejected liked-song update")
        return {"trackId": song_id, "liked": liked}

    async def preferences(self) -> dict[str, Any]:
        account = await self.account()
        playlists = await self.playlists()
        liked = await self.liked(100)
        return {"account": account, "playlists": playlists["playlists"], "liked": liked["songs"]}


def _qr_type(value: str) -> QRLoginType:
    normalized = value.strip().lower()
    if normalized == "wx":
        return QRLoginType.WX
    if normalized == "qq":
        return QRLoginType.QQ
    if normalized == "mobile":
        return QRLoginType.MOBILE
    raise ValueError("loginType must be wx, qq, or mobile")


def _qr_state(code: int) -> str:
    return {800: "expired", 801: "waiting_scan", 802: "waiting_confirm", 803: "authorized"}.get(code, "waiting_scan")


def _song_query(value: str) -> Any:
    from qqmusic_api.modules.song import SongQueryInfo

    return SongQueryInfo(id=int(value)) if value.isdigit() else SongQueryInfo(mid=value)


def _json_response(status: int, value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


async def _read_request(reader: asyncio.StreamReader) -> tuple[str, str, dict[str, str], bytes] | None:
    try:
        header_bytes = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), REQUEST_HEADER_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as error:
        raise HttpRequestError(408, "request header timeout") from error
    except asyncio.LimitOverrunError as error:
        raise HttpRequestError(431, "request headers too large") from error
    except asyncio.IncompleteReadError as error:
        raise HttpRequestError(400, "incomplete HTTP request") from error
    if len(header_bytes) > MAX_HEADER_BYTES:
        raise HttpRequestError(431, "request headers too large")
    lines = header_bytes.decode("latin1").split("\r\n")
    try:
        method, target, http_version = lines[0].split(" ", 2)
    except ValueError as error:
        raise HttpRequestError(400, "invalid HTTP request line") from error
    if http_version not in {"HTTP/1.0", "HTTP/1.1"}:
        raise HttpRequestError(400, "unsupported HTTP version")
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if not line:
            continue
        name, separator, value = line.partition(":")
        if not separator or not name.strip():
            raise HttpRequestError(400, "invalid HTTP header")
        header_name = name.lower().strip()
        if header_name in headers:
            raise HttpRequestError(400, "duplicate HTTP header")
        headers[header_name] = value.strip()
    raw_length = headers.get("content-length", "0") or "0"
    try:
        length = int(raw_length, 10)
    except ValueError as error:
        raise HttpRequestError(400, "content-length is invalid") from error
    if length < 0 or length > MAX_BODY_BYTES:
        raise HttpRequestError(413, "request body too large")
    if headers.get("transfer-encoding", "").lower() not in {"", "identity"}:
        raise HttpRequestError(400, "chunked request bodies are not supported")
    try:
        body = await asyncio.wait_for(reader.readexactly(length), REQUEST_HEADER_TIMEOUT_SECONDS) if length else b""
    except asyncio.TimeoutError as error:
        raise HttpRequestError(408, "request body timeout") from error
    except asyncio.IncompleteReadError as error:
        raise HttpRequestError(400, "incomplete HTTP request body") from error
    return method.upper(), target, headers, body


def _validate_request(headers: dict[str, str], method: str) -> None:
    provided = headers.get("x-one-radio-qq-token", "")
    if not provided or not compare_digest(provided, SIDECAR_TOKEN):
        raise HttpRequestError(401, "QQ Music sidecar authorization required")
    origin = headers.get("origin")
    if origin is not None and origin not in ALLOWED_ORIGINS:
        raise HttpRequestError(403, "Origin is not allowed")
    if method in {"POST", "PUT", "PATCH", "DELETE"}:
        content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise HttpRequestError(415, "JSON content type is required")


async def _handle_client(service: QqMusicService, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    status = 200
    payload: Any = {"error": "not found"}
    try:
        request = await _read_request(reader)
        if request is None:
            return
        method, target, headers, body = request
        _validate_request(headers, method)
        from urllib.parse import parse_qs, urlsplit

        url = urlsplit(target)
        path = url.path.rstrip("/") or "/"
        query = parse_qs(url.query)
        data: dict[str, Any] = {}
        if body:
            try:
                data = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise HttpRequestError(400, "JSON body is invalid") from error
            if not isinstance(data, dict):
                raise HttpRequestError(400, "JSON body must be an object")
        elif method in {"POST", "PUT", "PATCH", "DELETE"}:
            raise HttpRequestError(400, "JSON body is required")
        if method == "GET" and path == "/health":
            payload = await service.health()
        elif method == "POST" and path == "/logout":
            payload = await service.logout()
        elif method == "POST" and path == "/login/qr":
            payload = await service.create_qr(str(data.get("loginType", "mobile")))
        elif method == "GET" and path.startswith("/login/qr/"):
            key = path.split("/", 3)[-1]
            payload = await service.check_qr(key, (query.get("loginType") or [None])[0])
        elif method == "GET" and path == "/account":
            payload = await service.account()
        elif method == "GET" and path == "/preferences":
            payload = await service.preferences()
        elif method == "GET" and path == "/search":
            payload = await service.search((query.get("keyword") or [""])[0], int((query.get("limit") or [20])[0]), int((query.get("offset") or [0])[0]))
        elif method == "GET" and path == "/playlists":
            payload = await service.playlists(
                int((query.get("limit") or [100])[0]),
                int((query.get("offset") or [0])[0]),
            )
        elif method == "GET" and path == "/liked":
            payload = await service.liked(int((query.get("limit") or [100])[0]))
        elif method == "GET" and path == "/recent":
            payload = await service.recent(int((query.get("limit") or [100])[0]))
        elif method == "GET" and path == "/history":
            payload = await service.history((query.get("period") or ["all"])[0])
        elif method == "GET" and path in {"/recommendations", "/fm"}:
            payload = await service.recommendations()
        elif method == "GET" and path.startswith("/playlist/"):
            payload = await service.playlist_detail(path.split("/")[-1])
        elif method == "GET" and path.startswith("/song/") and path.endswith("/url"):
            payload = await service.song_url(path.split("/")[-2])
        elif method == "GET" and path.startswith("/song/") and path.endswith("/similar"):
            payload = {"songs": await service.similar(path.split("/")[-2])}
        elif method == "GET" and path.startswith("/song/"):
            payload = {"songs": await service.song_detail(path.split("/")[-1])}
        elif method == "POST" and path.startswith("/song/") and path.endswith("/like"):
            liked = data.get("liked")
            if not isinstance(liked, bool):
                raise ValueError("liked must be a boolean")
            song_type = data.get("songType", 0)
            if not isinstance(song_type, int) or song_type < 0:
                raise ValueError("songType must be a non-negative integer")
            expected_uid = data.get("expectedUid")
            if not isinstance(expected_uid, str) or not expected_uid or len(expected_uid) > 128:
                raise ValueError("expectedUid is invalid")
            payload = await service.set_song_liked(path.split("/")[-2], liked, song_type, expected_uid)
        elif method == "POST" and path == "/playlist":
            expected_uid = data.get("expectedUid")
            if not isinstance(expected_uid, str) or not expected_uid or len(expected_uid) > 128:
                raise ValueError("expectedUid is invalid")
            payload = await service.create_playlist(str(data.get("name", "")), expected_uid)
        elif method == "DELETE" and path.startswith("/playlist/"):
            dir_id = data.get("dirId")
            if not isinstance(dir_id, str) or not dir_id.isdigit() or int(dir_id) <= 0:
                raise ValueError("dirId must be a positive numeric string")
            expected_uid = data.get("expectedUid")
            if not isinstance(expected_uid, str) or not expected_uid or len(expected_uid) > 128:
                raise ValueError("expectedUid is invalid")
            payload = await service.delete_playlist(path.split("/")[-1], dir_id, expected_uid)
        elif method == "POST" and path.startswith("/playlist/") and path.endswith("/tracks/replace"):
            tracks = data.get("trackIds")
            if not isinstance(tracks, list) or not all(isinstance(item, str) for item in tracks):
                raise ValueError("trackIds must be a string array")
            dir_id = data.get("dirId")
            if not isinstance(dir_id, str) or not dir_id.isdigit() or int(dir_id) <= 0:
                raise ValueError("dirId must be a positive numeric string")
            expected_uid = data.get("expectedUid")
            if not isinstance(expected_uid, str) or not expected_uid or len(expected_uid) > 128:
                raise ValueError("expectedUid is invalid")
            payload = await service.replace_songs(path.split("/")[-3], dir_id, tracks, expected_uid)
        elif method == "POST" and path.startswith("/playlist/") and path.endswith("/tracks"):
            tracks = data.get("trackIds")
            if not isinstance(tracks, list) or not all(isinstance(item, str) for item in tracks):
                raise ValueError("trackIds must be a string array")
            dir_id = data.get("dirId")
            if not isinstance(dir_id, str) or not dir_id.isdigit() or int(dir_id) <= 0:
                raise ValueError("dirId must be a positive numeric string")
            expected_uid = data.get("expectedUid")
            if not isinstance(expected_uid, str) or not expected_uid or len(expected_uid) > 128:
                raise ValueError("expectedUid is invalid")
            payload = await service.add_songs(path.split("/")[-2], dir_id, tracks, expected_uid)
        else:
            status = 404
            payload = {"error": "not found"}
    except HttpRequestError as error:
        status, payload = error.status, {"error": error.message}
    except PermissionError as error:
        status, payload = 401, {"error": str(error)}
    except (ValueError, TypeError, json.JSONDecodeError) as error:
        status, payload = 400, {"error": str(error)}
    except BaseApiException:
        status, payload = 502, {"error": "QQ Music upstream request failed"}
    except Exception as error:  # Keep upstream details out of HTTP responses/logs.
        LOGGER.warning("QQ Music sidecar request failed: %s", type(error).__name__)
        status, payload = 502, {"error": "QQ Music upstream request failed"}
    body_bytes = _json_response(status, payload)
    if len(body_bytes) > MAX_RESPONSE_BYTES:
        status = 502
        body_bytes = _json_response(status, {"error": "QQ Music sidecar response is too large"})
    writer.write(
        f"HTTP/1.1 {status} {'OK' if status < 400 else 'Error'}\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        f"Content-Length: {len(body_bytes)}\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n\r\n".encode("latin1") + body_bytes,
    )
    await writer.drain()
    writer.close()
    await writer.wait_closed()


async def _serve_client(service: QqMusicService, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        await asyncio.wait_for(_handle_client(service, reader, writer), SDK_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        body = _json_response(504, {"error": "QQ Music upstream request timed out"})
        try:
            writer.write(
                f"HTTP/1.1 504 Error\r\n"
                "Content-Type: application/json; charset=utf-8\r\n"
                f"Content-Length: {len(body)}\r\n"
                "Cache-Control: no-store\r\n"
                "Connection: close\r\n\r\n".encode("latin1") + body,
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()


async def main() -> None:
    if HOST not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("QQ Music sidecar must bind to loopback")
    service = QqMusicService()
    server = await asyncio.start_server(lambda r, w: _serve_client(service, r, w), HOST, PORT, limit=MAX_HEADER_BYTES)
    LOGGER.info("QQ Music sidecar listening on %s:%s", HOST, PORT)
    try:
        async with server:
            await server.serve_forever()
    finally:
        await service.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
