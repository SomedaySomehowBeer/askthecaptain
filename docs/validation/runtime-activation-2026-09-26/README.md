# Restricted runtime activation — 26 September 2026

The owner authorised the credential switch and old-credential retirement. The same staging API
machine and already-reviewed #162 image were used. No customer-record reset or production
configuration change was made.

- [Activation checks](activation.txt): actual restricted login, same-endpoint isolation/privilege
  checks, and read-only counts under an existing owner's tenant context. These are counts only;
  no record content was read or changed. The check passed again after the control-plane reset.
- [Browser check](browser-check.txt): signed-out Google entry at 390 and 1440 pixels, no overflow
  or script errors. There was no authenticated browser session; no end-to-end signed-in acceptance
  is claimed.
- [Fleet check](fleet-final.txt): one machine per staging app; production/embedding configurations
  unchanged and stopped. API configuration matches the guarded image with normal autostart/idle stop.
- [Initial retirement run](retirement-initial.txt): the reset was accepted once and both Neon
  operations finished. Verification then stopped because the classifier expected FATAL, while
  Neon emitted ERROR. Direct Postgres verification established SQLSTATE 28P01 for the old login.
  [#165](https://github.com/SomedaySomehowBeer/askthecaptain/pull/165) corrects only that exact
  password-failure classification, with 44 passing fixtures and green CI. The first resume skipped
  the reset, then correctly refused state drift outside the role.
- [Scoped-refresh fix](https://github.com/SomedaySomehowBeer/askthecaptain/pull/166): an ephemeral
  override removes the project dependency during the refresh, with the same strict state gates.
  All 47 offline fixtures pass. A local builtin-only OpenTofu probe confirms that project+role
  refresh becomes role-only, including when an output references both resources. Shell probes
  confirm a preexisting override survives refusal and the run’s own file is removed on failure.

[#164](https://github.com/SomedaySomehowBeer/askthecaptain/pull/164) documents the provider-specific
activation method and contains the reviewed manual retirement/state-reconciliation workflow.
The initial pre-hashed password attempt was rejected before LOGIN was enabled. The working method
uses verified TLS and a bound parameter through a temporary invoker function, with logging checks
before sending it. No credentials appear in these artifacts; local and remote transfer files were
deleted. See the [runbook](../../runbooks/paused.md) for final operation status and remaining scope.
