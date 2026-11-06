import * as path from 'path';

/**
 * Cursor's globalStorage `state.vscdb` for an OS. Pure: the platform, home
 * directory, and APPDATA are inputs, so each OS can be tested on any machine.
 */
export function cursorStateDbPathFor(
  platform: NodeJS.Platform,
  home: string,
  appData?: string
): string {
  switch (platform) {
    case 'win32':
      return path.join(
        appData ?? path.join(home, 'AppData', 'Roaming'),
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb'
      );
    case 'darwin':
      return path.join(
        home,
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb'
      );
    default:
      return path.join(
        home,
        '.config',
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb'
      );
  }
}
