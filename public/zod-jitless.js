// Zod no genera código en tiempo de ejecución (new Function): así la
// validación funciona igual con una Content-Security-Policy estricta, sin
// 'unsafe-eval' ni avisos. Es un script clásico para ejecutarse antes que los
// módulos, que construyen los esquemas al cargar.
globalThis.__zod_globalConfig = Object.assign(
  globalThis.__zod_globalConfig || {},
  {
    jitless: true,
  },
)
