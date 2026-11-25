declare const __E2E__: boolean;

/** Minimal typings for File System Access API members that lib.dom does not yet declare everywhere. */
interface FileSystemPermissionDescriptorLike {
  mode?: 'read' | 'readwrite';
}

interface Window {
  showDirectoryPicker(options?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }): Promise<FileSystemDirectoryHandle>;
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemPermissionDescriptorLike): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemPermissionDescriptorLike): Promise<PermissionState>;
}
