// Stroke icons, 24×24, currentColor. Decorative unless a label is passed.
import type { ReactNode } from 'react';

function Svg(props: { children: ReactNode; className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      role={props.label ? 'img' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
    >
      {props.children}
    </svg>
  );
}

type P = { className?: string; label?: string };
const mk = (paths: ReactNode) => (p: P) => <Svg {...p}>{paths}</Svg>;

export const IArrow = (p: P) => <Svg {...p} className={`arrow ${p.className ?? ''}`}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;
export const IArrowUpRight = mk(<path d="M7 17 17 7M8 7h9v9" />);
export const ICheck = mk(<path d="m5 12.5 4.2 4.2L19 7" />);
export const IX = mk(<path d="M6 6l12 12M18 6 6 18" />);
export const IMenu = mk(<path d="M4 7h16M4 12h16M4 17h16" />);
export const IChevron = mk(<path d="m6 9 6 6 6-6" />);
export const IChevronRight = mk(<path d="m9 6 6 6-6 6" />);
export const ICopy = mk(<><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" /></>);
export const ISearch = mk(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>);
export const IWallet = mk(<><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18a2 2 0 0 1 2 2v1" /><rect x="3.5" y="7.5" width="17" height="12" rx="2.5" /><path d="M16 13.5h1.5" /></>);
export const IZap = mk(<path d="M13 3 5 13.5h6L10.5 21 19 10.5h-6L13 3Z" />);
export const IShield = mk(<><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6L12 3Z" /><path d="m8.8 12 2.3 2.3 4.3-4.6" /></>);
export const IKey = mk(<><circle cx="8" cy="15" r="4" /><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" /></>);
export const ILayers = mk(<><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /><path d="m3 17.5 9 5 9-5" opacity=".5" /></>);
export const IWebhook = mk(<><path d="M9 16.5a4 4 0 1 1-3.5-6.8" /><path d="m12 7-3.6 6.3" /><circle cx="12" cy="5.5" r="2.5" /><path d="M15 9.5a4 4 0 1 1 1.5 7.6" /><path d="M8.5 16.5H17" /><circle cx="18" cy="16.5" r="0.6" /></>);
export const ICode = mk(<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />);
export const IRefresh = mk(<><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 20v-4h-4" /></>);
export const ILock = mk(<><rect x="4.5" y="10.5" width="15" height="10" rx="2.5" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /><path d="M12 14.5v2" /></>);
export const IGlobe = mk(<><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 3.7 5.4 3.7 8.5s-1.2 5.9-3.7 8.5c-2.5-2.6-3.7-5.4-3.7-8.5S9.5 6.1 12 3.5Z" /></>);
export const IServer = mk(<><rect x="4" y="4" width="16" height="7" rx="2" /><rect x="4" y="13" width="16" height="7" rx="2" /><path d="M8 7.5h.01M8 16.5h.01M12 7.5h4M12 16.5h4" /></>);
export const IDatabase = mk(<><ellipse cx="12" cy="6" rx="7.5" ry="3" /><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" /><path d="M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" /></>);
export const ICpu = mk(<><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></>);
export const IUsers = mk(<><circle cx="9" cy="8.5" r="3.5" /><path d="M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5" /><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.8c1.6.8 2.7 2.6 3 5.2" /></>);
export const ICoins = mk(<><ellipse cx="9" cy="7" rx="5.5" ry="2.5" /><path d="M3.5 7v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V7" /><path d="M9.5 16.4c.6.4 1.5.6 2.5.6 3 0 5.5-1.1 5.5-2.5" /><ellipse cx="15" cy="13" rx="5.5" ry="2.5" /><path d="M9.5 13v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-4" /></>);
export const IGauge = mk(<><path d="M4.5 17a8.5 8.5 0 1 1 15 0" /><path d="m12 13 4-4" /><circle cx="12" cy="13" r="1.4" /></>);
export const IClock = mk(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
export const IBell = mk(<><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>);
export const IFlask = mk(<><path d="M9.5 3h5M10 3v6L4.8 18.2A1.9 1.9 0 0 0 6.5 21h11a1.9 1.9 0 0 0 1.7-2.8L14 9V3" /><path d="M7.5 14h9" /></>);
export const IStore = mk(<><path d="M4 9.5 5.5 4h13L20 9.5" /><path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0" /><path d="M5.5 12v8h13v-8" /><path d="M10 20v-4.5h4V20" /></>);
export const ILink = mk(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>);
export const IBox = mk(<><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>);
export const ITerminal = mk(<><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17" /></>);
export const ISparkles = mk(<><path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.8l-1.6-5.6L5 10.6 10.4 9 12 3.5Z" /><path d="M19 16v4M17 18h4M5 3v3M3.5 4.5h3" /></>);
export const IBranch = mk(<><circle cx="6" cy="5.5" r="2" /><circle cx="6" cy="18.5" r="2" /><circle cx="18" cy="8.5" r="2" /><path d="M6 7.5v9M18 10.5c0 4-6 3-11 6.5" /></>);
export const IFile = mk(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>);
export const IAlert = mk(<><path d="M10.3 4.3 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" /><path d="M12 9.5v4M12 17h.01" /></>);
export const IInfo = mk(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8h.01" /></>);
export const IEye = mk(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>);
export const IScale = mk(<><path d="M12 4v16M7 20h10M5 7h14" /><path d="m5 7-3 6a3 3 0 0 0 6 0L5 7ZM19 7l-3 6a3 3 0 0 0 6 0l-3-6Z" /></>);
export const IFingerprint = mk(<><path d="M5.5 10a6.5 6.5 0 0 1 13 0v1.5" /><path d="M8.5 20c.8-1.8 1-3.9 1-6v-4a2.5 2.5 0 0 1 5 0v3.5c0 2.6-.4 4.8-1.4 6.6" /><path d="M5.5 14.5c0 1.6-.3 3-.9 4.2M18.5 15c0 1.8-.3 3.4-.8 4.8M12 10v4.5c0 2.6-.5 5-1.6 7" /></>);
export const IPlay = mk(<path d="M7 5.5v13l11-6.5-11-6.5Z" />);
export const IHex = mk(<path d="m12 2.8 8 4.6v9.2l-8 4.6-8-4.6V7.4l8-4.6Z" />);
export const IReceipt = mk(<><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>);
export const IGamepad = mk(<><rect x="2.5" y="7" width="19" height="11" rx="5.5" /><path d="M7.5 10.5v4M5.5 12.5h4M15.5 11.5h.01M18 13.5h.01" /></>);
export const IBook = mk(<><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" /><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" /></>);
export const IPercent = mk(<><path d="M19 5 5 19" /><circle cx="7" cy="7" r="2.5" /><circle cx="17" cy="17" r="2.5" /></>);
export const ISend = mk(<><path d="M21 3 10 14" /><path d="m21 3-7 18-4-7-7-4 18-7Z" /></>);
export const IActivity = mk(<path d="M3 12h4l3-8 4 16 3-8h4" />);
export const IHistory = mk(<><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3 4v4h4M12 7.5V12l3 2" /></>);
export const IPlus = mk(<path d="M12 5v14M5 12h14" />);
export const IMinus = mk(<path d="M5 12h14" />);
export const IGithub = mk(<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />);

export function Logo(props: { id: string; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={props.className} aria-hidden="true">
      <defs>
        <linearGradient id={`${props.id}-g`} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8dffa8" />
          <stop offset="0.45" stopColor="#34d65c" />
          <stop offset="1" stopColor="#21c7a8" />
        </linearGradient>
      </defs>
      <path d="M16 1.8 28.3 8.9v14.2L16 30.2 3.7 23.1V8.9L16 1.8Z" fill={`url(#${props.id}-g)`} />
      <path d="M21.2 12.2a6.2 6.2 0 1 0 1.1 5.3H16.4" fill="none" stroke="#03130a" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
