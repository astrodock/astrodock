// `astrodock://auth?...` is the sign-in redirect. On iOS the browser sheet
// keeps it; on Android it also reaches the app as a link. It is not a screen:
// stay where we are and let expo-web-browser finish the sign-in.
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    if (/^(astrodock:\/\/)?\/?auth(\?|$)/i.test(path)) return initial ? '/' : null;
    return path;
  } catch {
    return '/';
  }
}
