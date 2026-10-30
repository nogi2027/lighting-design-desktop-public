export type ImportSource = { filename: string; title?: string; bytes: Uint8Array };
import type { WorkspaceState } from '../lib/types';
export type DesktopState = WorkspaceState & { id: string; title: string; document: WorkspaceState['document'] & { firstPage: number } };
