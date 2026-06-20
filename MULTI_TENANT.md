# Multi-tenant & hosted-SaaS roadmap (deferred)

Astrodock's locked threat model is a **single-tenant VPS run by a fully-trusted operator**
(see `SECURITY.md`). The features below only earn their keep once there are *multiple,
mutually-distrusting* operators or paying customers — i.e. deployment **mode 3** in
`OPEN_SOURCE.md` ("cloud-managed SaaS, implemented as orchestrated single-tenant instances").

They are **explicitly out of scope for now.** The current production-hardening work
(`BUILD_PLAN.md` → Phase 6) targets the single-host operator and must not assume any of this.
This doc is the holding pen so the ideas aren't lost and so single-host work doesn't quietly
drift into multi-tenant territory.

> Boundary rule of thumb: if a feature is useful to *one* operator running *their own* box,
> it belongs in Phase 6. If it only matters because operators/customers must be isolated from
> each other, it belongs here.

## Deferred — team / multi-admin
- **Multiple admin accounts** beyond the single seeded admin. `users.is_admin` already exists,
  so the data model is close — but a real team needs the items below before it's safe.
- **RBAC / roles** — at minimum `owner` vs `read-only` (auditor) vs `deploy-only`. Today every
  admin is omnipotent (`requireAdmin` is binary).
- **Session revocation & refresh** — the current model is a single `ADMIN_JWT_SECRET`, 8h
  bearer tokens, no per-session revocation (`SECURITY.md`). A team needs per-user sessions,
  logout-everywhere, and forced rotation.
- **SSO / external IdP** (Google Workspace, GitHub org, SAML/OIDC) for operator login.
- **Per-admin scoping** — restrict an admin to a subset of apps (the API-token model already
  has `app_scope`; admins would need the equivalent).

> Note: the **audit log itself is NOT deferred** — a single operator still benefits from a
> "what changed and when" trail, so it lives in Phase 6. Only the multi-admin *roles* layer
> that sits on top of it is deferred here.

## Deferred — SaaS orchestration (mode 3)
- **Per-customer instance provisioning** — spin up / tear down an isolated single-tenant stack
  per customer (the orchestration layer *above* a single Astrodock, not inside it).
- **Billing & metering** — usage capture (compute-hours, storage GB, egress, build minutes),
  plan limits, Stripe (or similar) integration, dunning.
- **Tenant lifecycle** — trials, suspension on non-payment, data export, hard delete with
  retention windows.
- **Fleet management** — upgrade/patch many instances, per-instance health rollups, a control
  plane *over* the control planes.

## Deferred — isolation & quotas (cross-tenant)
- **Hard resource isolation** between customers — stronger than the current PM2/Docker model
  (cgroup/quota enforcement, or per-tenant VMs/gVisor as flagged in `OPEN_SOURCE.md` prior-art).
- **Per-customer quotas** — storage caps, app counts, bandwidth ceilings *enforced as policy*,
  distinct from the single-box disk-pressure management in Phase 6 (which protects one operator
  from themselves, not customers from each other).
- **Noisy-neighbor controls** — CPU/IO fairness across tenants.

## Deferred — customer-facing surfaces
- **White-labeling** — custom branding/domains on the admin UI per customer.
- **Customer dashboards & analytics** — self-serve usage, billing, and app analytics portals.
- **Public per-customer status pages** (the *operator-internal* status page is in Phase 6).
- **Tenant-segregated logs/audit** — every observability surface filtered by tenant boundary.

---

When mode 3 becomes the active goal, promote items from here into a dedicated build plan and
re-validate the threat model in `SECURITY.md` (multi-tenant changes the trust assumptions
fundamentally — it is not an incremental toggle).
