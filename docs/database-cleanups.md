# Deferred database cleanups

Data a migration stops using but keeps for one more release, so a server
still on the previous release (a rolling upgrade or a rollback) keeps
working. Remove each in a later release, once no server of the release that
reads it can still run.

| Kept data                                    | Replaced by                                                                   | Kept by                              | Removal                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| `dashboards.pinned`, `dashboards.sort_order` | `user_dashboards` (each user's pinned flag and order)                         | `20261126201928_per_user_theme_pins` | A migration that drops both columns, and the schema columns marked legacy.    |
| `platform_config` row `ui.theme`             | `user_preferences` `accent`, `dock_labels`, `theme_preset`, `custom_theme_id` | `20261126201928_per_user_theme_pins` | A migration that deletes the row. Nothing in this release reads or writes it. |
