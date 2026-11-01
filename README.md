# joycon-web

A WebHID dashboard for Nintendo Switch controllers. Connect a Joy-Con (L/R) or
Pro Controller over Bluetooth and inspect buttons, sticks, IMU data, battery,
player LEDs, HOME LED, and rumble in a live 3D view.

## Requirements

- Chrome, Edge, or another Chromium-based browser with WebHID.
- macOS, Windows, or Linux with the controller paired in the OS Bluetooth
  settings.
- HTTPS or `localhost` (WebHID requires a secure context).

## Development

```bash
bun install
bun run dev
```

Open <http://localhost:3000>. Press a controller's sync button to pair it with
the OS, then click **Connect Joy-Con** and pick it from the browser chooser.
Previously granted controllers reconnect automatically.

Click **Arrange** to open the compact controller-order menu. Drag a chip and
drop it near the left/right edges of another chip to reorder the 3D layout.
Dropping on a compatible left/right chip's horizontal middle merges them into
one rigid unit: the target chip highlights and shows **Release to merge**, while
the dragged chip's placeholder is hidden. The preview draws a translucent
connector and rotates both halves together. Use **Unlink** to split a pair, or
**×** to disconnect a controller.

For keyboard sorting, focus a chip's drag area, press **Space**, move with the
arrow keys, then press **Space** to drop.

## Scripts

```bash
bun run dev        # Bun dev server with HMR
bun test           # protocol + 3D model unit tests
bun run typecheck  # tsc --noEmit
bun run build      # clean static build into dist/
bun run preview    # serve the built dist/
```

## Deployment

The build is a static site. `wrangler.toml` is configured to publish `dist/`
with Cloudflare Workers static assets:

```bash
bun run build
bunx wrangler deploy
```

## Notes

- Protocol references:
  [dekuNukem/Nintendo_Switch_Reverse_Engineering](https://github.com/dekuNukem/Nintendo_Switch_Reverse_Engineering).
- The HID layer parses report `0x30` (inputs + 3 IMU frames) and `0x21`
  (subcommand replies). Subcommands are serialized because `0x21` replies do
  not echo the request packet number.
- Orientation is integrated from the gyroscope with accelerometer tilt
  correction. Use **Recenter** while the controller is still to reset the
  reference frame and gyro bias.
- The right Joy-Con's IMU is mounted mirrored, so its raw Y/Z axes are inverted
  before fusion. The displayed IMU values and 3D orientation therefore use the
  same canonical axes as the left Joy-Con and Pro Controller.
- Linked Joy-Cons use the left half's orientation for the shared rigid body; if
  that half has no reading, the right half is used instead.
