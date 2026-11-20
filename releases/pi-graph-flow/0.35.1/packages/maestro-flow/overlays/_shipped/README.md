# Shipped Overlay Examples

This directory contains read-only overlay examples shipped by the `maestro` package. These are installed to `~/.maestro/overlays/_shipped/` and are **not** auto-applied — they're reference implementations you can copy to the overlay root and edit.

To activate an example:

```bash
cp ~/.maestro/overlays/_shipped/cli-verify-after-execute.json ~/.maestro/overlays/
maestro overlay apply
```

To remove:

```bash
maestro overlay remove cli-verify-after-execute
```

See `~/.maestro/workflows/overlays.md` for the full overlay format and contract.
