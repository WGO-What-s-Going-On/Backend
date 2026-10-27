import { validateRuntimeFiles } from './runtime-files.js';

// 이미지 기본 진입점에서만 fail-fast한다. 로컬 개발의 기존 degraded 동작은 유지한다.
await validateRuntimeFiles();
await import('./main.js');
