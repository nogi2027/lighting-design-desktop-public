interface ImportMetaEnv {
  readonly VITE_SYNC_ENGINE?: "v1" | "v2";
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}
