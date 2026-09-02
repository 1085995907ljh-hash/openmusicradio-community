import { HOST_PROFILES, type HostProfileId } from "../shared/program-options";

const HOST_PET_ASSETS: Readonly<Record<HostProfileId, string>> = Object.freeze({
  anxuan: "/hosts/long-anxuan.png",
  anran: "/hosts/long-anran.png",
  anya: "/hosts/long-anya.png",
  longxin: "/hosts/long-xin.png",
  xiaocheng: "/hosts/long-xiaocheng.png",
  longhao: "/hosts/long-hao.png",
});

const HOST_PORTRAIT_ASSETS: Readonly<Record<HostProfileId, string>> = Object.freeze({
  anxuan: "/hosts/portraits/long-anxuan-v5.png",
  anran: "/hosts/portraits/long-anran-v5.png",
  anya: "/hosts/portraits/long-anya-v5.png",
  longxin: "/hosts/portraits/long-xin-v5.png",
  xiaocheng: "/hosts/portraits/long-xiaocheng-v5.png",
  longhao: "/hosts/portraits/long-hao-v5.png",
});

export function RadioHostAvatar({ profileId, portrait = false }: { profileId: HostProfileId; portrait?: boolean }) {
  const profile = HOST_PROFILES[profileId];
  return <img className={`host-avatar ${portrait ? "host-avatar-portrait" : ""}`} src={(portrait ? HOST_PORTRAIT_ASSETS : HOST_PET_ASSETS)[profileId]} alt="" aria-hidden="true" draggable={false} />;
}
