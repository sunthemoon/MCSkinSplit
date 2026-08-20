/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_COMPLETION_WORKSPACE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
