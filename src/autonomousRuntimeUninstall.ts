import { uninstallRegisteredAutonomousRuntimeService } from './autonomousRuntimeService';

void uninstallRegisteredAutonomousRuntimeService().catch((error) => {
  process.stderr.write(`SoloMap background service cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
