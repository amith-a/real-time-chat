import { build } from 'esbuild';

await build({
  entryPoints: [
    'src/handlers/auth/authorizer.ts',
    'src/handlers/websocket/connect.ts',
    'src/handlers/websocket/disconnect.ts',
    'src/handlers/websocket/default.ts',
    'src/handlers/websocket/sendMessage.ts',
    'src/handlers/http/users.ts',
    'src/handlers/http/messages.ts',
    'src/handlers/http/rooms.ts',
  ],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['@aws-sdk/*'],
  outdir: 'dist',
  entryNames: '[name]',
});
