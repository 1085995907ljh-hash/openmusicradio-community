import assert from "node:assert/strict";
import test from "node:test";
import { isBroadcastNavigationLocked } from "../src/web/topbar-policy.js";

test("settings and diagnostics stay locked while a broadcast can own audio", () => {
  assert.equal(isBroadcastNavigationLocked("preparing"), true);
  assert.equal(isBroadcastNavigationLocked("on_air"), true);
  assert.equal(isBroadcastNavigationLocked("closing"), true);
});

test("topbar navigation remains available outside an active broadcast", () => {
  assert.equal(isBroadcastNavigationLocked(undefined), false);
  assert.equal(isBroadcastNavigationLocked("draft"), false);
  assert.equal(isBroadcastNavigationLocked("awaiting_confirmation"), false);
  assert.equal(isBroadcastNavigationLocked("completed"), false);
  assert.equal(isBroadcastNavigationLocked("stopped"), false);
  assert.equal(isBroadcastNavigationLocked("failed"), false);
});
