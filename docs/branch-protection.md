# Branch protection recommendations

`master` currently has no protection rules — this repo has a single
maintainer and started with direct pushes. Once anyone else has push access
(or before the agent gets deployed against a real event), enable protection
on `master` under **Settings → Branches → Add branch protection rule**
(pattern: `master`):

- **Require a pull request before merging** — no direct pushes to `master`,
  including for the maintainer, so every change gets a second look before it
  ships to a booth that has to run unattended.
- **Require approvals** — at least 1.
- **Require status checks to pass before merging**, once CI is wired up.
  There's no GitHub Actions workflow yet; when one is added, it should at minimum run:
  - `npm run typecheck`
  - `npm test` (outbox sync worker, strip compositor, camera fallback)
- **Do not allow force pushes** to `master`.
- **Do not allow branch deletion**.
- **Require conversation resolution before merging** — optional, but useful
  once there's more than one contributor.

None of this blocks solo, fast-moving work today — it's here so it's a
one-click checklist to turn on later rather than something to reconstruct
from scratch.
