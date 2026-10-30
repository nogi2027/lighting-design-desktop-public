import assert from "node:assert/strict";
import test from "node:test";
import { validEnvelope } from "../lib/sync-v2/validation.ts";
import { readLimitedText } from "../lib/read-limited-text.ts";
import { readLimitedJson } from "../lib/sync-v2/http.ts";

const base = {
  protocol: 2,
  workspaceId: "lighting-design",
  epoch: "validation-epoch",
  operationId: "validation-operation",
  sessionId: "validation-session",
  actorId: "actor-a",
  createdAt: "2026-09-10T00:00:00.000Z",
  dependsOn: [],
};

test("every structured action validates its complete typed shape", () => {
  const cue = { id: "validation-cue", number: null, title: "Validation cue", description: "", technicalNotes: "", mode: "unassigned", blackout: false, sceneId: "scene-01", page: 9, anchorType: "line", selectedText: "A line", enclosingLine: "A line", anchorY: 0.2, anchorOrder: 1 };
  const validActions = [
    { type: "createCue", cue },
    { type: "assignNextNumber", cueId: cue.id, expectedAssignmentVersion: 1, expectedLifecycleVersion: 1, expectedPositionVersion: 1 },
    { type: "assignCueNumbers", cues: [{ cueId: cue.id, expectedAssignmentVersion: 1, expectedLifecycleVersion: 1, expectedPositionVersion: 1 }] },
    { type: "setCueNumber", cueId: cue.id, number: "LX 4", expectedAssignmentVersion: 1 },
    { type: "unassignCue", cueId: cue.id, expectedAssignmentVersion: 1 },
    { type: "setCueMode", cueId: cue.id, mode: "planned", expectedAssignmentVersion: 1 },
    { type: "setBlackout", cueId: cue.id, blackout: true, expectedBlackoutVersion: 1 },
    { type: "moveCue", cueId: cue.id, position: { sceneId: cue.sceneId, page: cue.page, anchorType: cue.anchorType, selectedText: cue.selectedText, enclosingLine: cue.enclosingLine, anchorX: cue.anchorX, anchorY: cue.anchorY, anchorOrder: cue.anchorOrder }, expectedPositionVersion: 1, expectedAssignmentVersion: 1 },
    { type: "setSceneOwners", scenes: [{ sceneId: cue.sceneId, ownerId: "actor-a", expectedVersion: 1 }] },
    { type: "createOrUpdateProfile", profile: { id: "actor-a", name: "Actor A", role: "Lighting Team", initials: "NG", color: "#35a7ff" }, expectedVersion: 1 },
    { type: "addNote", discussion: { id: "validation-note", targetType: "cue", cueId: cue.id, sceneId: cue.sceneId, authorId: "actor-a", content: "Valid", createdAt: base.createdAt, resolved: false, replies: [] } },
    { type: "addReply", discussionId: "validation-note", reply: { id: "validation-reply", authorId: "actor-a", content: "Valid", createdAt: base.createdAt } },
    { type: "setDiscussionResolved", discussionId: "validation-note", resolved: true, expectedVersion: 1 },
    { type: "setInboxRead", eventIds: ["validation-event"], profileId: "actor-a", read: true },
    { type: "setInboxPinned", eventIds: ["validation-event"], profileId: "actor-a", pinned: true },
    { type: "deleteCue", cueId: cue.id, expectedLifecycleVersion: 1 },
    { type: "restoreCue", cueId: cue.id, expectedLifecycleVersion: 1 },
    { type: "restoreTextVersion", cueId: cue.id, historyRevision: 0, expectedDocumentRevision: 1 },
    { type: "acknowledgeNotice", noticeId: "validation-notice", profileId: "actor-a" },
  ];
  for (const [index, action] of validActions.entries()) assert.equal(validEnvelope({ ...base, operationId: `validation-operation-${index}`, action }), true, action.type);

  const malformed = [
    { type: "setBlackout", cueId: cue.id, blackout: true },
    { type: "setCueMode", cueId: cue.id, mode: "surprise", expectedAssignmentVersion: 1 },
    { type: "moveCue", cueId: cue.id, position: { sceneId: cue.sceneId }, expectedPositionVersion: 1, expectedAssignmentVersion: 1 },
    { type: "setSceneOwners", scenes: [] },
    { type: "addReply", discussionId: "validation-note", reply: { id: "reply", authorId: "actor-a", content: "", createdAt: base.createdAt } },
    { type: "setInboxRead", eventIds: ["same", "same"], profileId: "actor-a", read: true },
    { type: "deleteCue", cueId: cue.id },
  ];
  for (const [index, action] of malformed.entries()) assert.equal(validEnvelope({ ...base, operationId: `invalid-operation-${index}`, action }), false, action.type);
});

test("bounded request readers reject oversized streams without retaining them", async () => {
  const body = `"${"x".repeat(1_000_001)}"`;
  assert.equal(await readLimitedText(new Request("http://local.test", { method: "PUT", body }), 1_000_000), null);
  const parsed = await readLimitedJson(new Request("http://local.test", { method: "POST", headers: { "content-type": "application/json" }, body }), 1_000_000);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.response.status, 413);
});
