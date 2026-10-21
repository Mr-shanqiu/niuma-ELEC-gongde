# macOS appearance and input recovery checkpoint

## Implemented

- New open-front wooden hamster habitat and plump hamster, generated with the built-in image tool from the approved concept. Green-key backgrounds decoded once into cached premultiplied-alpha images. The generated sources are in `assets/scenes/hamster-wheel/runtime/`.
- Fixed perspective habitat, subtle foot-anchored animal stride. This is a simplified stride animation; the tread does not yet physically circulate.
- One four-card appearance dialog with thumbnails, exclusive selection, Confirm and Cancel. Selection does not change the active scene before confirmation.
- Persistent tap-health polling, including silent startup, failed tap creation, invalid taps and disabled taps. Listen-only HID tap with session tap fallback. No event fields are read.
- Event sources, save and animation timers also service modal panels. Counter saturation prevents signed overflow.
- Optional `--diagnostics` writes permission/tap status, aggregate received events and total to stderr only; no event contents.

## Executed acceptance

- `scripts/build-macos.sh`: PASS, arm64 + x86_64, no compiler warnings in final build.
- `sh scripts/test-macos.sh`: PASS. Exercises callback logic directly with 100 key-down events, all mouse-down categories, scroll grouping, ignored key-up, no animation queue, modal timer completion, overflow saturation, four-card selection isolation, sprite alpha and removal of green pixels, and rendered snapshots.
- These callback tests do not inject real system input and are not proof of a functioning global event tap.
- `scripts/audit-offline.sh`: PASS.
- `codesign --verify --deep --strict`: PASS for local ad-hoc signature only, not Developer ID or notarization.
- ZIP: 3,969,167 bytes. App: 4,112 KiB.
- One idle sample: 0.0% CPU, RSS 44,528 KiB. This is not a long-duration performance test and exceeds the original 30 MB memory target.
- Rendered snapshots: `/tmp/niuma-acceptance/appearance-grid.png`, `hamster-rest.png`, `hamster-stride.png`.

## Runtime blocker

Final app launched from `dist/牛马电子功德.app` with diagnostics. At observation:

```
listen_allowed=0 tap_valid=0 tap_enabled=0 received=0 total=13700
```

The system preflight for the running build returns false despite the user's earlier approval of an application entry. Existing approval must not be assumed to apply to this rebuilt ad-hoc executable. No TCC database changes or resets were performed. Input Monitoring settings were opened for the user.

Next: allow the current build in macOS settings, observe a valid/enabled tap and increasing aggregate received events/total while typing and clicking in another app. Relaunch the app if macOS requires it. Full end-to-end global counting remains BLOCKED until this is observed. Runtime log: `/tmp/niuma-acceptance/live-input-final.log`.

Windows was not changed or tested in this work block. Visual acceptance of the new hamster and real interaction with the appearance dialog remain with the user.

## Follow-up: actual cause confirmed

- User reports counting only when clicking the pet, not global keyboard/mouse input. Earlier nonzero event totals were not proof of global recovery.
- macOS TCC logs explicitly report: `Failed to match existing code requirement for subject cn.niuma.merit and service kTCCServiceListenEvent`. Existing approval refers to a different ad-hoc code requirement than the running build.
- Removed the preflight hard gate, added disabled-HID fallback to session tap, recreation of taps that cannot be re-enabled, and aggregate key/click/scroll diagnostics. Final logic tests and offline audit pass; ZIP is 3,969,797 bytes.
- The last executable is now frozen for permission acceptance. Do not rebuild or re-sign during this check.
- Stopped the running app and successfully ran `tccutil reset ListenEvent cn.niuma.merit`. This resets only this app's input-monitoring approval, not other apps or other services.
- Opened Input Monitoring settings and revealed the exact app in Finder: `dist/牛马电子功德.app`.
- Next requires user OS consent: add this exact app back into Input Monitoring and enable it. Then launch the SAME binary with diagnostics and test keyboard/mouse in a different app. Global acceptance remains pending.
