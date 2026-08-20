/**
 * Side-effect boot module for the dev-only fresh-install mode. MUST stay the
 * very first import of `main.tsx`: zustand `persist` stores rehydrate
 * synchronously the moment their module is imported, so the localStorage
 * wipe/restore has to execute before any store module gets evaluated — code
 * in the `main.tsx` body would run far too late.
 */
import {
  restoreFreshInstallBackup,
  runFreshInstallReset,
} from './freshInstall'

runFreshInstallReset()
restoreFreshInstallBackup()
