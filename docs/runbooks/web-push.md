# Web Push

What the repository owner does once so Captain can push briefs and reminders to devices (plan §5
"Notifications", §6 notify steps).

1. **Generate VAPID keys**, once, anywhere with Node:

   ```bash
   npx web-push generate-vapid-keys
   ```

2. **Set them on the API app** (`askthecaptain-api-staging`, the live API under D17):
   `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, and `WEB_PUSH_SUBJECT` (a `mailto:` address the push
   services can contact, for example `mailto:ryan@somedaysomehow.beer`). All three or none: with any
   missing, Settings → Notifications says push is not set up and nothing is sent.

3. **Never rotate the keys.** Every subscription is bound to the public key; a new key means every
   device must subscribe again. Keep the pair in the same place as the other secrets.

4. **Try it**: open Settings → Notifications on a phone (on iPhone, add Captain to the Home Screen from
   Safari first and open it from there), tap *Push to this device*, allow notifications, then *Send a
   test*. A delivery is journaled in `push_deliveries` whether it succeeded or not; a device the push
   service reports gone is disabled and shown as such.

The service worker at `/sw.js` caches nothing; it only shows pushes and opens the app where the push
points. The web manifest at `/manifest.webmanifest` makes Captain installable (plan §10).
