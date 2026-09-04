import assert from "node:assert/strict";
import test from "node:test";
import { isBroadcastNavigationLocked } from "../src/web/topbar-policy.js";

test("settings stay locked only while the broadcast is changing ownership", () => {
  assert.equal(isBroadcastNavigationLocked("preparing"), true);
  assert.equal(isBroadcastNavigationLocked("closing"), true);
});

test("settings remain available during stable playback and outside a broadcast", () => {
  assert.equal(isBroadcastNavigationLocked(undefined), false);
  assert.equal(isBroadcastNavigationLocked("draft"), false);
  assert.equal(isBroadcastNavigationLocked("awaiting_confirmation"), false);
  assert.equal(isBroadcastNavigationLocked("on_air"), false);
  assert.equal(isBroadcastNavigationLocked("completed"), false);
  assert.equal(isBroadcastNavigationLocked("stopped"), false);
  assert.equal(isBroadcastNavigationLocked("failed"), false);
});
