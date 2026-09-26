'use client';
import { useEffect, useId, useRef, useState } from 'react';

export type MenuAction = 'edit' | 'delete' | 'pin' | 'unpin';
const labels: Record<MenuAction, string> = { pin: 'Pin for everyone', unpin: 'Unpin', edit: 'Edit', delete: 'Delete' };

/** The "⋯" actions of one message: a button that opens a small menu of only the actions that apply. Arrow keys move,
 *  Escape or a click outside closes and returns focus to the button. */
export function MessageMenu({ label, actions, busy, onAction }: { label: string; actions: MenuAction[]; busy: boolean; onAction(a: MenuAction): void }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const button = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
		const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && event.target !== button.current) setOpen(false); };
		document.addEventListener('pointerdown', outside);
		return () => document.removeEventListener('pointerdown', outside);
	}, [open]);
	if (actions.length === 0) return null;
	const close = () => { setOpen(false); button.current?.focus(); };
	const keys = (event: React.KeyboardEvent) => {
		const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
		const at = items.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === 'Escape') { event.preventDefault(); close(); }
		else if (event.key === 'ArrowDown') { event.preventDefault(); items[(at + 1) % items.length]?.focus(); }
		else if (event.key === 'ArrowUp') { event.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
		else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
		else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus(); }
		else if (event.key === 'Tab') setOpen(false);
	};
	return <span className="chat-menu">
		<button ref={button} type="button" className="chat-menu__button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
			disabled={busy} onClick={() => setOpen(v => !v)}>⋯</button>
		{open ? <div ref={menu} id={id} role="menu" aria-label={label} className="chat-menu__list" onKeyDown={keys}>
			{actions.map(action => <button key={action} type="button" role="menuitem" tabIndex={-1} className={action === 'delete' ? 'chat-menu__danger' : undefined}
				onClick={() => { setOpen(false); button.current?.focus(); onAction(action); }}>{labels[action]}</button>)}
		</div> : null}
	</span>;
}
