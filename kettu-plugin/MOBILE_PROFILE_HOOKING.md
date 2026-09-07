# Kettu Mobile Profile Hooking

## 1) Baseline integration (current)

- `ConfigPanel` is exposed by `plugin.settings`.
- `ConfigPanel` is also exposed by `plugin.userProfileBadge.component`.
- Source: `/home/runner/work/key-intercept-v2/key-intercept-v2/kettu-plugin/src/index.js`

## 2) Kettu mobile hook compatibility checklist

Use this checklist during iOS/Android validation to confirm which entrypoints are actually honored by the current Kettu build.

- [ ] `settings` entrypoint is rendered and opens `ConfigPanel`
- [ ] `userProfileBadge` entrypoint appears on self profile
- [ ] `userProfileBadge` entrypoint appears on other-user profile
- [ ] `userProfileBadge` entrypoint appears on guild member profile
- [ ] `userProfileBadge` entrypoint appears on DM profile
- [ ] `userProfileBadge` entrypoint appears on blocked/non-friend profile
- [ ] Runtime diagnostics capture both `settings-entrypoint` and `user-profile-badge-entrypoint` events
- [ ] Runtime diagnostics capture profile ID candidate props for each profile surface

## 3) Discord mobile profile surfaces to evaluate

| Discord mobile UI surface | Expected hook path | Notes |
| --- | --- | --- |
| Profile header (self) | `userProfileBadge` | Primary target for direct profile UX |
| Profile header (other user) | `userProfileBadge` | Should resolve target user ID from profile props |
| Profile overflow/menu actions | `settings` fallback + manual target | Use when badge entrypoint is unavailable |
| Profile subviews (guild/DM variants) | `userProfileBadge` first, fallback to `settings` | Validate candidate ID extraction across prop shapes |
| Blocked/non-friend profile view | `userProfileBadge` first, fallback to `settings` | Validate ACL and remote access request behavior |

## 4) Runtime observability workflow

1. Open Kettu panel from settings and from profile badge (when available).
2. In **Profile Hook Diagnostics**, inspect recent events:
   - `settings-entrypoint`
   - `user-profile-badge-entrypoint`
   - `config-panel-context`
   - `refresh-*`
3. Confirm `user_id_candidates` and `effective_profile_user_id` align with the profile currently open.
4. Use **Capture Snapshot** to record an explicit diagnostics sample per test case.

## 5) Structured mobile test pass matrix

Run this matrix on both iOS and Android:

| Case | Badge visible? | Hook event fired | Effective target ID correct? | Config load/save works? | Notes |
| --- | --- | --- | --- | --- | --- |
| Self profile |  |  |  |  |  |
| Other user profile |  |  |  |  |  |
| Guild member profile |  |  |  |  |  |
| DM profile |  |  |  |  |  |
| Blocked/non-friend profile |  |  |  |  |  |

## 6) Hook strategy decision

- **Primary hook point:** `userProfileBadge` when event fires and badge is visible on target profile surface.
- **Fallback hook point:** `settings` entrypoint with manual target Discord ID in **Profile Hook Routing**.

## 7) Final UX path

- Preferred UX: open target profile and tap profile badge control to open `ConfigPanel` scoped to that user.
- Fallback UX: open plugin settings, set manual target Discord ID, then edit that profile configuration.

## 8) Acceptance criteria

Validation is complete when all are true:

- Profile UI entry appears on supported surfaces.
- Opening the entry shows `ConfigPanel`.
- Effective target user ID is resolved correctly.
- Config read/write succeeds for own profile and permitted remote profiles.
- Fallback settings path remains functional when badge entrypoint is unavailable.
