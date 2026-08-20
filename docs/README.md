# docs/

The published documentation for `@zanreal/medusa-infakt`.

These pages are the source of what renders at
<https://zanreal.com/docs/oss/medusa-infakt>. The marketing site clones this
repository at build time and copies this directory into its own content tree, so
a change merged here is what the site ships on its next deploy. Nothing is
maintained by hand on the other side.

## Layout

| File | Purpose |
| --- | --- |
| `index.en.mdx`, `index.pl.mdx` | Overview: what the plugin is, why it is cautious, how a host installs it, the two switches. |
| `invoicing.en.mdx`, `invoicing.pl.mdx` | The pipeline: trigger, gates, the paid gate, the state machine, the crash window, backoff. |
| `ksef.en.mdx`, `ksef.pl.mdx` | The three filing modes, what makes an invoice B2B, `requireActive`, and what a rejection does. |
| `reconciliation.en.mdx`, `reconciliation.pl.mdx` | Adopting invoices that already exist in inFakt: the gates, the grades, the dry run. |
| `settings.en.mdx`, `settings.pl.mdx` | Every option, the admin-editable overrides, the environment variables, every route. |
| `meta.json`, `meta.pl.json` | Sidebar title, description and page order, per locale. |

This `README.md` is deliberately **not** copied by the sync. It explains the
directory to someone browsing GitHub; it is not a page on the site.

## Conventions

- **Every page exists in both locales**, suffixed `.en.mdx` and `.pl.mdx`.
- **Each locale is written from the code, not translated from the other.** The
  two versions make the same argument and are expected to differ in examples and
  emphasis.
- **Cross-links between pages are relative** and point at the file, for example
  `[KSeF filing](./ksef.en.mdx)`. That resolves when browsing this directory on
  GitHub, and the site's sync rewrites it to a site route on the way in. The
  locale is taken from the link target, so `./ksef.pl.mdx` lands on the Polish
  page.
- **No em or en dashes.** Use a spaced hyphen for a parenthetical.
- **No real buyer, invoice or company data**, in examples or anywhere else. The
  test fixtures in this repository are synthetic on purpose; keep the docs that
  way too.
