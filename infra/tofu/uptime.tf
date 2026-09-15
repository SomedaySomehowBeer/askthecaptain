# Better Stack replaces the production-synthetic Actions cron (which cost ~8,600 private-repo
# minutes a month at 5-minute resolution). Checks run from Better Stack's own network, so
# monitoring stays alive when our infrastructure is the thing that broke. Alerts go to the
# account's email and the Better Stack phone app.

# Staging is what actually serves people while we are developing (apex, www and app. all point
# at it). The half-hour cadence is deliberate: machines scale to zero now, and a tight check
# loop would hold them awake around the clock — this wakes them for a couple of minutes an hour.
# Tighten it when warm machines stop being the thing we are saving.
resource "betteruptime_monitor" "api_staging_readyz" {
  url              = "https://api-staging.askthecaptain.app/readyz"
  monitor_type     = "keyword"
  required_keyword = "\"ok\":true"
  check_frequency  = 1800
  regions          = ["au"]
  email            = true
  push             = true
}

