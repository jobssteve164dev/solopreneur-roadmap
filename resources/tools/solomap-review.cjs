#!/usr/bin/env node
'use strict';

// Kept at the old source path so stale callers cannot recreate retired business files.
if (require.main === module) {
  console.error('旧版文件复盘入口已退役；请在 SoloMap 设置中发起经验复盘。');
  process.exitCode = 1;
}
