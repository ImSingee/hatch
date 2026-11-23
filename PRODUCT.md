# Product

## Register

product

## Users

People who want their own small software — trackers, dashboards, internal tools,
usage monitors — without writing or operating code. They range from
non-technical to technical, and they treat Hatch as a personal hub: a place to
describe an app in plain language, watch the Agent build and deploy it, then live
with it day to day in the sidebar and on dashboards.

## Product Purpose

Hatch is an AI-native personal app platform. You describe an app in plain
language; the Agent scaffolds it, builds it, deploys it, and pins it into your
sidebar and dashboards. Success is the gap between "I wish I had a tool for this"
and "it's running and on my dashboard" shrinking to a short conversation. The
product's job is to make that loop feel calm, trustworthy, and craftsmanlike —
never like a noisy developer console.

## Brand Personality

Warm, calm, friendly, precise. Hatch is a personal desk: your Apps, widgets and
the Agent sit on it like things you own, not like rows in an admin console. The
voice is a quietly capable maker: confident without shouting, friendly without
being cute. Rounded, heavy type and soft white sheets signal approachability;
one accent colour and plain language signal trust. Emotional goal: the user
feels at home, and feels the product is on their side and knows what it is
doing.

Reference: a tidy personal desktop. A warm desk surface, a few white sheets
resting on it, each thing where the user put it. The visual system is called
"Desk" and is specified in `DESIGN.md`.

## Anti-references

- Generic SaaS dashboards: cold corporate blue, gradient-soaked hero metrics,
  busy chrome.
- Developer consoles: dense monospace panels, log walls and status noise as
  the default view.
- Warmth by decoration: gradients, glows, textures or tinted cards. The warmth
  of Desk is a flat cream ground under plain white sheets. The ground carries
  three large flat shapes, each a quiet tint close to the ground; they are
  part of the desk, not ornament on content, and they never get a gradient, a
  glow or a place inside a sheet.
- "Ghost cards": a 1px border plus a soft wide drop shadow on the same
  surface. A sheet has a shadow or a hairline, never both.
- Neon / techy dark dashboards trying to look "powerful".
- Toy-like UI: radii above 24px on content surfaces (pills, the dock bar and
  the ground shapes are the exceptions), bouncy motion, several
  bright colours competing on one screen. Rounded is friendly; inflated is not.

## Design Principles

1. **A desk with sheets on it.** The ground is a warm cream with a few large,
   flat, pale shapes on it; content lives on
   white sheets that float on a soft, ink-tinted shadow. Depth says what is
   on top: card, then menu, then window. It is never decoration.
2. **One accent, on purpose.** Neutral surfaces carry the work; the accent
   marks the primary action, the current item, selection and links. The user
   picks the accent; the rest of the palette stays neutral, and other hues
   appear only to carry status or to tell Apps apart.
3. **Weight makes the hierarchy.** One rounded sans (Nunito) everywhere, with
   mono for code and values to copy. Size and weight do the work before
   colour does: heavy headings and labels, medium body, nothing thin.
4. **Shadow or hairline, not both.** A sheet on the ground floats; a group
   inside a sheet is outlined and stays flat. No nested cards. Fields and
   dividers stay visible on both the ground and a sheet.
5. **Quiet, intentional motion.** Short ease-out transitions on things that
   respond to the pointer; always a reduced-motion alternative.
6. **One system on every surface.** Every colour, radius, shadow and font
   comes from one token file, so web, mobile, desktop and, later, generated
   Apps look like parts of the same desk.

## Accessibility & Inclusion

- Target WCAG AA: body text ≥ 4.5:1, large text ≥ 3:1, on the ground and on a
  sheet; placeholders meet body contrast.
- Visible keyboard focus ring (a 2 px ink ring on every control; see `DESIGN.md`).
- Every animation has a `prefers-reduced-motion` fallback.
- Hatch is light-only; supported light surfaces meet the contrast targets, and
  color never conveys state alone.
