export const I18N_NAMESPACE = "pi-compact-tui/pi-tips";

type ScopeFn = (key: string, fallback: string) => string;
type I18nSDK = { scope: (namespace: string) => ScopeFn };

let scopeImpl: ScopeFn;
try {
  const sdk = (await import("@juicesharp/rpiv-i18n")) as I18nSDK;
  scopeImpl = sdk.scope(I18N_NAMESPACE);
} catch {
  scopeImpl = (_key, fallback) => fallback;
}

export const t: ScopeFn = scopeImpl;
