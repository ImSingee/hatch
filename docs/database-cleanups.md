# Deferred database cleanups

Data a migration stops using but keeps for one more release, so a server
still on the previous release (a rolling upgrade or a rollback) can still
read it. Remove each in a later release, once no server of the release that
reads it can still run.

After `20261126201928_per_user_theme_pins`, a server on the release before
it reads dashboards, draws the instance theme and pins Apps. Two gaps remain
while such a server runs, and both are accepted for the overlap:

- It cannot tell users' pins apart: it lists every user's copy of each pin.
  Its code has no notion of a pin owner, so this cannot be fixed from this
  release.
- Its pins have no user. This release never reads or changes such rows, so
  they stay hidden until the cleanup below hands them to every user, the way
  the original migration copied the instance pins. They are not lost.

| Kept data                                    | Replaced by                                                                   | Kept by                              | Removal                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboards.pinned`, `dashboards.sort_order` | `user_dashboards` (each user's pinned flag and order)                         | `20261126201928_per_user_theme_pins` | A migration that drops both columns, and the schema columns marked legacy.                                                                                                                                                                                |
| `platform_config` row `ui.theme`             | `user_preferences` `accent`, `dock_labels`, `theme_preset`, `custom_theme_id` | `20261126201928_per_user_theme_pins` | A migration that deletes the row. Nothing in this release reads or writes it.                                                                                                                                                                             |
| `sidebar_items.user_id` nullable             | A required `user_id` on every pin                                             | `20261126201928_per_user_theme_pins` | With the column drops: copy each row whose `user_id` is null to every user (new ids, same label, entry point and order, after the user's own pins), delete the null-user rows, then set the column `NOT NULL` (and drop the nullable note in the schema). |
