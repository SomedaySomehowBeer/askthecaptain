# Record the Cloudflare IDs adopted from the legacy Namecheap forwarding and
# parking setup. The apex ID reflects the provider-forced A-to-CNAME replacement.
import {
  to = cloudflare_dns_record.apex
  id = "${var.cloudflare_zone_id}/1416aeff670d5d7a1243e895086168d6"
}

import {
  to = cloudflare_dns_record.www
  id = "${var.cloudflare_zone_id}/a6849d1979ed60dc6feb84a31a9411bb"
}
