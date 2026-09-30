import { test } from "node:test";
import assert from "node:assert/strict";

import { PreferenceRequests } from "./preference-requests.ts";

test("the opening request is current for the root it captured", () => {
  const requests = new PreferenceRequests();
  const request = requests.open("/a");
  assert.equal(requests.isCurrent(request, "/a"), true);
});

test("a project switch makes old usage inert and a refresh current", () => {
  const requests = new PreferenceRequests();
  const old = requests.open("/a");
  assert.equal(requests.isCurrent(old, "/b"), false);
  const current = requests.refresh("/b");
  assert.notEqual(current, null);
  assert.equal(requests.isCurrent(old, "/b"), false);
  assert.equal(requests.isCurrent(current, "/b"), true);
});

test("a newer request prevents an older response repainting the dialog", () => {
  const requests = new PreferenceRequests();
  const old = requests.open(null);
  const current = requests.refresh(null);
  assert.equal(requests.isCurrent(old, null), false);
  assert.equal(requests.isCurrent(current, null), true);
});

test("closing invalidates pending work and reopening gets a new identity", () => {
  const requests = new PreferenceRequests();
  const old = requests.open("/a");
  requests.close();
  assert.equal(requests.isCurrent(old, "/a"), false);
  assert.equal(requests.refresh("/a"), null);
  const reopened = requests.open("/a");
  assert.equal(requests.isCurrent(old, "/a"), false);
  assert.equal(requests.isCurrent(reopened, "/a"), true);
});

test("a clear confirmation retains the root it asked about", () => {
  const requests = new PreferenceRequests();
  const question = requests.open("/old");
  requests.refresh("/new");
  assert.equal(question.root, "/old");
});

test("closing and reopening invalidates an old clear work generation", () => {
  const requests = new PreferenceRequests();
  requests.open("/a");
  const oldClear = requests.beginWork("/a");
  requests.close();
  const reopened = requests.open("/a");
  assert.equal(requests.isCurrent(oldClear, "/a"), false);
  assert.equal(requests.isCurrent(reopened, "/a"), true);
});
