import type { CSSProperties } from 'react';
import type { WorkflowCatalog, WorkflowDefinition } from '../../../lib/api.ts';
import { runStates, stateWords, stepLines, triggerWords, type Line, type StateCounts, type Token } from './steps.ts';

/** A workflow drawn as its steps, in the manner of a shortcut: what starts it, then one card per
 *  step in the catalogue's words, with the values it uses and saves as chips and `each` and
 *  `branch` as indented blocks. Given a run's journal it also says how far each step got. */
export function WorkflowSteps({ definition, catalog, run }: { definition: WorkflowDefinition; catalog: WorkflowCatalog; run?: { path: string; state: string }[] }) {
	const lines = stepLines(definition, catalog);
	const states = run ? runStates(run) : null;
	const starts = definition.triggers.map(triggerWords).join(', and ');
	return (
		<ol className="flow" aria-label={`The steps of ${definition.name}`}>
			<li className="flow__item"><div className="flow__card flow__card--start"><div className="flow__head"><span className="flow__kind flow__kind--start">Starts</span><span className="flow__text">{starts ? starts.charAt(0).toUpperCase() + starts.slice(1) : 'Never on its own'}.</span></div></div></li>
			{lines.map((line) => <FlowLine key={line.path} line={line} counts={states?.get(line.path) ?? null} />)}
		</ol>
	);
}

function FlowLine({ line, counts }: { line: Line; counts: StateCounts | null }) {
	const style = { '--depth': line.depth } as CSSProperties;
	if (line.type === 'end') return <li className="flow__item flow__item--end" style={style}><span className="flow__end">{line.of === 'each' ? `End of each ${line.noun}` : 'End if'}</span></li>;
	if (line.type === 'each') return <li className="flow__item" style={style}><div className="flow__card flow__card--flow"><div className="flow__head"><span className="flow__kind flow__kind--flow">Repeat</span><span className="flow__text">For each {line.noun} in <Tokens tokens={line.list} /></span><State counts={counts} /></div>{line.independent ? <p className="flow__sub">Each {line.noun} waits on its own; the others carry on.</p> : null}</div></li>;
	if (line.type === 'if') return <li className="flow__item" style={style}><div className="flow__card flow__card--flow"><div className="flow__head"><span className="flow__kind flow__kind--flow">If</span><span className="flow__text"><Tokens tokens={line.when} /></span></div></div></li>;
	if (line.type === 'otherwise') return <li className="flow__item" style={style}><div className="flow__card flow__card--flow"><div className="flow__head"><span className="flow__kind flow__kind--flow">Otherwise</span></div></div></li>;
	return (
		<li className="flow__item" style={style}>
			<div className="flow__card">
				<div className="flow__head">
					<span className={`flow__kind flow__kind--${line.kind}`}>{line.label}</span>
					<span className="flow__text">{line.does}</span>
					{line.savedAs ? <span className="flow__saves">→ <span className="flow__var">{line.savedAs}</span></span> : null}
					<State counts={counts} />
				</div>
				{line.when ? <p className="flow__sub">Only if <Tokens tokens={line.when} />.</p> : null}
				{line.detail.map((tokens, i) => <p className="flow__sub" key={i}><Tokens tokens={tokens} /></p>)}
			</div>
		</li>
	);
}

function Tokens({ tokens }: { tokens: Token[] }) {
	return <>{tokens.map((token, i) => token.kind === 'text' ? <span key={i}>{token.text}</span>
		: token.kind === 'value' ? <span key={i} className="flow__var">{token.text}</span>
		: <span key={i} className="flow__setting" title={token.title}>{token.text}</span>)}</>;
}

function State({ counts }: { counts: StateCounts | null }) {
	if (!counts) return null;
	const { text, tone } = stateWords(counts);
	return <span className={`flow__state flow__state--${tone}`}>{text}</span>;
}
