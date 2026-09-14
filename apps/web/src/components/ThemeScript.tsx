/** Settles the theme before first paint: the person's saved choice, else what the system prefers.
 *  Runs before hydration, so it is a raw script rather than an effect. */
const script = `try{var t=localStorage.getItem('captain.theme');if(t!=='light'&&t!=='dark')t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}`;
export function ThemeScript() { return <script dangerouslySetInnerHTML={{ __html: script }} />; }
