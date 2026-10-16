// Capture harness for in-app help screenshots, on top of the agent-app-screenshots skill.
//
// Each area script (for example `scripts/help/captures/<area>.mjs`) opens the app as a demo user
// for a role, navigates with real clicks and crops specific components (a dialog, a toolbar, a
// button) at 2x, measuring their clickable zones. Working PNGs and their manifest go to $OUT,
// outside the repo; a publish step turns them into WebP plus the catalog (screenshots.json).
//
// Requirements: the app running against a database seeded with demo data (NEVER production),
// ImageMagick 7 (`magick`), python3 and Playwright (env PLAYWRIGHT=/path/playwright/index.mjs if
// it does not resolve). It uses its own Chromium, never anyone's browser profile.
//
// Configure through env:
//   CAP_USERS      JSON file {role: email} with the demo users of the seed
//   CAP_PASSWORD   demo password from the seed (never a real account's)
//   CAP_HIDE_KEY   localStorage key that keeps the help panel closed during captures
//   CAP_LOCALE / CAP_TZ   browser locale and timezone (default en-US / UTC)
//   CAP_HIGHLIGHT  CSS color for the highlight outline (default #2563eb)
// The sign-in in `sesionCookies` is written for better-auth (/api/auth/sign-in/email): adapt it.
// Copy measure.js and crop.py from agent-app-screenshots into ./lib next to this file.
//
//   OUT=/tmp/captures BASE=http://localhost:3000 node scripts/help/captures/<area>.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MEASURE = fs.readFileSync(path.join(DIR, "lib/measure.js"), "utf8");
const BASE = process.env.BASE ?? "http://localhost:3199";
/** Demo password from the seed; never a real account's */
const DEMO_PASSWORD = process.env.CAP_PASSWORD ?? "";

/** Demo users per role, from CAP_USERS */
export const USUARIOS = process.env.CAP_USERS ? JSON.parse(fs.readFileSync(process.env.CAP_USERS, "utf8")) : {};

async function loadPlaywright() {
  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout?.trim();
  for (const c of [process.env.PLAYWRIGHT, "playwright", npmRoot && `${npmRoot}/playwright/index.mjs`].filter(Boolean)) {
    try {
      return await import(c.startsWith("/") ? pathToFileURL(c).href : c);
    } catch {}
  }
  throw new Error("No encuentro Playwright: define PLAYWRIGHT=/ruta/playwright/index.mjs");
}

// El Chromium más reciente que haya en disco (un Playwright más nuevo que sus navegadores busca otro)
function chromiumPath() {
  if (process.env.CHROME) return process.env.CHROME;
  const dir = process.platform === "darwin" ? path.join(os.homedir(), "Library/Caches/ms-playwright") : path.join(os.homedir(), ".cache/ms-playwright");
  if (!fs.existsSync(dir)) return undefined;
  const builds = fs
    .readdirSync(dir)
    .filter((d) => /^chromium_headless_shell-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const b of builds) {
    for (const sub of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64", "chrome-headless-shell-linux64"]) {
      const p = path.join(dir, b, sub, "chrome-headless-shell");
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

/** Espera a red quieta, fuentes y animaciones finitas: lo que se mide es lo que se captura */
async function settle(page, timeout = 3000) {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
  await page
    .evaluate(
      (t) =>
        Promise.race([
          (async () => {
            await document.fonts.ready;
            const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
            await Promise.all(finite.map((a) => a.finished.catch(() => {})));
          })(),
          new Promise((r) => setTimeout(r, t)),
        ]),
      timeout,
    )
    .catch(() => {});
}

// Sesiones por rol guardadas fuera del repo y reutilizadas: el login tiene límite de 5 por minuto
const SESIONES = process.env.CAP_SESIONES ?? path.join(os.tmpdir(), "help-capture-sessions");

/** Cookies de sesión de un usuario demo (inicia sesión solo si no hay una guardada válida) */
export async function sesionCookies(rol) {
  fs.mkdirSync(SESIONES, { recursive: true, mode: 0o700 });
  const file = path.join(SESIONES, `${rol}.json`);
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const check = await fetch(`${BASE}/api/auth/get-session`, { headers: { Cookie: saved.map((c) => `${c.name}=${c.value}`).join("; ") } });
    if (check.ok && (await check.json())?.user) return saved;
  }
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { Origin: BASE, "Content-Type": "application/json" },
    body: JSON.stringify({ email: USUARIOS[rol], password: DEMO_PASSWORD }),
  });
  if (!res.ok) throw new Error(`No se pudo iniciar sesión como ${rol}: ${res.status}`);
  const url = new URL(BASE);
  const cookies = res.headers.getSetCookie().map((c) => {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: url.hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" };
  });
  fs.writeFileSync(file, JSON.stringify(cookies), { mode: 0o600 });
  return cookies;
}

/**
 * Zonas clicables dentro del recorte (botones, pestañas, campos, opciones de menú…), con su
 * nombre accesible y su caja en fracciones del recorte (0-1). Con ellas el asistente señala
 * el sitio exacto donde actuar: `[captura:id#zona]`. El recorte se calcula igual que crop.py
 * (margen `pad`, a 2x y sin salirse del viewport) para que las cajas casen al píxel.
 */
const ZONAS = ({ sel, pad }) => {
  const root = document.querySelector(sel);
  if (!root) return { zonas: [], principal: null };
  const r = root.getBoundingClientRect();
  const x0 = Math.max(0, Math.floor((r.left - pad) * 2)) / 2;
  const y0 = Math.max(0, Math.floor((r.top - pad) * 2)) / 2;
  const x1 = Math.min(innerWidth * 2, Math.ceil((r.right + pad) * 2)) / 2;
  const y1 = Math.min(innerHeight * 2, Math.ceil((r.bottom + pad) * 2)) / 2;
  const W = x1 - x0, H = y1 - y0;
  const INTERACTIVE = 'button, a[href], [role=button], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=checkbox], [role=switch], [role=combobox], [role=radio], input:not([type=hidden]), select, textarea';
  // El principal puede ser un grupo (p. ej. los botones de una fila): cuenta como zona, y sus botones también
  const CANDIDATES = `${INTERACTIVE}, [data-cap-principal]`;
  const slug = (t) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const TIPOS = { date: "fecha", time: "hora", "datetime-local": "fecha y hora", number: "numero", email: "email", search: "buscar", file: "archivo" };
  const nameOf = (el) => {
    const own = el.getAttribute("aria-label") || el.labels?.[0]?.innerText || el.getAttribute("placeholder") || el.getAttribute("title");
    // Un campo sin etiqueta se nombra por su tipo, nunca por el valor que tenga escrito
    const text = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? (TIPOS[el.type] ?? "") : el.innerText;
    return (own || text || "").replace(/\s+/g, " ").trim().slice(0, 60);
  };
  // El principal puede ser un grupo sin ser clicable: su caja es la unión de sus botones
  const boxOf = (el) => {
    if (el.matches(INTERACTIVE)) return el.getBoundingClientRect();
    const kids = [...el.querySelectorAll(INTERACTIVE)].map((k) => k.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
    if (!kids.length) return el.getBoundingClientRect();
    const left = Math.min(...kids.map((b) => b.left)), top = Math.min(...kids.map((b) => b.top));
    const right = Math.max(...kids.map((b) => b.right)), bottom = Math.max(...kids.map((b) => b.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const visible = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) < 0.1) return false;
    }
    return true;
  };
  // Por geometría, no por el DOM: los guiones unen varios elementos con un marco invisible
  // (pointer-events: none) que no los contiene. Vale todo lo que cae dentro del recorte y está
  // encima (un diálogo abierto tapa los botones de la página de detrás).
  const onTop = (el, b) => {
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && (el.contains(hit) || hit.contains(el));
  };
  const els = [...document.querySelectorAll(CANDIDATES)];
  const used = new Map();
  const zonas = [];
  let principal = null;
  for (const el of els) {
    // Un botón dentro de otro elemento interactivo ya cuenta con el de fuera
    const outer = el.parentElement?.closest(INTERACTIVE);
    if (outer && !el.hasAttribute("data-cap-principal")) continue;
    const grupo = !el.matches(INTERACTIVE);
    const b = boxOf(el);
    if (b.width < 4 || b.height < 4 || !visible(el) || (!grupo && !onTop(el, b))) continue;
    const bx0 = Math.max(b.left, x0), by0 = Math.max(b.top, y0), bx1 = Math.min(b.right, x1), by1 = Math.min(b.bottom, y1);
    if (bx1 - bx0 < b.width * 0.6 || by1 - by0 < b.height * 0.6) continue; // fuera o casi fuera del recorte
    const label = grupo ? "Botones señalados" : nameOf(el);
    const base = grupo ? "acciones" : slug(label) || (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? "campo" : "boton");
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const key = n === 1 ? base : `${base}-${n}`;
    const f = (v) => Math.round(v * 10000) / 10000;
    // Tipo: «c» clic (botón, pestaña, opción, desplegable), «e» campo donde se escribe, «g» grupo
    const t = grupo ? "g" : /^(INPUT|TEXTAREA)$/.test(el.tagName) && !/^(checkbox|radio|button|submit|file)$/.test(el.type) ? "e" : "c";
    zonas.push({ k: key, l: label || null, t, x: f((bx0 - x0) / W), y: f((by0 - y0) / H), w: f((bx1 - bx0) / W), h: f((by1 - by0) / H) });
    if (el.hasAttribute("data-cap-principal")) principal = key;
    if (zonas.length >= 40) break;
  }
  return { zonas, principal };
};

const HIGHLIGHT_CSS = `
  [data-cap-resalte] {
    outline: 2px solid ${process.env.CAP_HIGHLIGHT ?? "#2563eb"} !important;
    outline-offset: 3px !important;
    box-shadow: 0 0 0 7px color-mix(in srgb, ${process.env.CAP_HIGHLIGHT ?? "#2563eb"} 30%, transparent) !important;
  }
  /* Sin cursor de texto ni anillos de foco que distraigan */
  * { caret-color: transparent !important; }
  /* El indicador de desarrollo de Next no sale en ninguna captura */
  nextjs-portal { display: none !important; }
`;

/**
 * Abre la app con un usuario demo. Devuelve helpers para navegar y recortar.
 * @param {{ rol?: keyof typeof USUARIOS, ancho?: number, alto?: number, out?: string }} opts
 */
export async function abrir({ rol = "admin", ancho = 1440, alto = 900, out = process.env.OUT } = {}) {
  if (!out) throw new Error("Define OUT: carpeta de trabajo fuera del repo");
  fs.mkdirSync(out, { recursive: true });
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ executablePath: chromiumPath(), args: [`--lang=${process.env.CAP_LOCALE ?? "en-US"}`] });
  const ctx = await browser.newContext({
    viewport: { width: ancho, height: alto },
    deviceScaleFactor: 2,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: process.env.CAP_LOCALE ?? "en-US",
    timezoneId: process.env.CAP_TZ ?? "UTC",
  });
  await ctx.addCookies(await sesionCookies(rol));
  // El panel del asistente y el hilo guardado no deben aparecer en las capturas
  await ctx.addInitScript((KEY) => {
    try {
      if (KEY) localStorage.setItem(KEY, "0");
    } catch {}
  }, process.env.CAP_HIDE_KEY ?? "");
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const manifestFile = path.join(out, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : {};

  async function prepare() {
    await page.addStyleTag({ content: HIGHLIGHT_CSS }).catch(() => {});
  }

  const cap = {
    page,
    settle: (t) => settle(page, t),

    /** Navega a una ruta de la app y espera a que se asiente */
    async ir(ruta) {
      await page.goto(`${BASE}${ruta}`, { waitUntil: "domcontentloaded" });
      await settle(page);
      await prepare();
    },

    /**
     * Recorta un elemento. `target`: Locator o selector CSS. `resaltar`: Locator del botón a
     * destacar dentro del recorte. `meta`: { seccion, shows, when } para el catálogo.
     */
    async foto(id, target, meta, { pad = 10, resaltar = null, redact = [], keep = [] } = {}) {
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`id inválido: ${id}`);
      if (!meta?.seccion || !meta?.shows || !meta?.when) throw new Error(`${id}: faltan seccion, shows o when`);
      await settle(page);
      await prepare();
      const sel = `[data-cap="${id}"]`;
      if (typeof target === "string") {
        await page.locator(target).first().evaluate((el, v) => el.setAttribute("data-cap", v), id);
      } else {
        await target.first().evaluate((el, v) => el.setAttribute("data-cap", v), id);
      }
      // Sin anillo de foco en campos y botones (los menús y desplegables conservan el foco: es su borde)
      await page.evaluate(() => {
        const el = document.activeElement;
        if (el instanceof HTMLElement && !el.closest('[role="menu"],[role="listbox"],[role="dialog"] [cmdk-root]') && /^(INPUT|TEXTAREA|BUTTON|SELECT|A)$/.test(el.tagName)) el.blur();
      });
      // El botón a destacar no se pinta en la imagen: se mide como zona principal y el panel
      // dibuja el recuadro encima (así la misma captura sirve para señalar cualquier otro botón)
      if (resaltar) await resaltar.first().evaluate((el) => el.setAttribute("data-cap-principal", ""));
      // Sin el ratón encima de nada (salvo que la captura sea de un estado hover)
      if (!meta.hover) await page.mouse.move(0, alto - 1);
      await page.waitForTimeout(150);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
      try {
        const measured = await page.evaluate(`(${MEASURE})(${JSON.stringify({ sel, redact, keep, pad })})`);
        const { zonas, principal } = await page.evaluate(ZONAS, { sel, pad });
        await page.screenshot({ path: path.join(tmp, "viewport.png"), scale: "device", caret: "hide" });
        const outFile = path.join(out, `${id}.png`);
        process.stdout.write(
          execFileSync("python3", [path.join(DIR, "lib/crop.py"), path.join(tmp, "viewport.png"), measured, outFile, String(pad)], {
            encoding: "utf8",
          }),
        );
        if (resaltar && !principal) console.warn(`${id}: el botón a resaltar no está dentro del recorte`);
        manifest[id] = { seccion: meta.seccion, shows: meta.shows, when: meta.when, corners: meta.corners ?? null, zonas, principal };
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
        return outFile;
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        await page
          .evaluate(() => {
            document.querySelectorAll("[data-cap],[data-cap-principal]").forEach((el) => {
              el.removeAttribute("data-cap");
              el.removeAttribute("data-cap-principal");
            });
          })
          .catch(() => {});
      }
    },

    /**
     * Recorta el diálogo abierto (o el menú/popover que se indique) sin el velo de fondo:
     * margen 0 y esquinas redondeadas transparentes (las pone `publicar.mjs`). Vale también
     * para menús y popovers (`target`).
     */
    async dialogo(id, meta, { target = '[role="dialog"]', resaltar = null } = {}) {
      const loc = typeof target === "string" ? page.locator(target).last() : target;
      await loc.waitFor({ state: "visible" });
      // Radio real del contenedor (px a 1x): las esquinas se vuelven transparentes al publicar
      const radio = await loc.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
      return cap.foto(id, loc, { ...meta, corners: radio }, { pad: 0, resaltar });
    },

    /** Cierra diálogos y menús abiertos */
    async escape() {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
    },

    close: () => browser.close(),
  };
  return cap;
}
