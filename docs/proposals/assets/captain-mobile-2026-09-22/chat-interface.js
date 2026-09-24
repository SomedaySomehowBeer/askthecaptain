// One message fixture per conversation. Item previews and full chat share message identities.
const chatThreads={
  packaging:{title:'Packaging slot',date:'Tuesday 22 September',context:'Summer lager launch',messages:[
    {id:'p1',author:'Ryan White',initials:'RW',time:'09:00',text:'Keep the existing reservations in place until a replacement is confirmed.',pinned:true},
    {id:'p2',author:'Jess Carter',initials:'JC',time:'09:05',text:'Please allow time for cleaning and maintenance.'},
    {id:'p3',author:'Beau Neunuebel',initials:'BN',time:'09:20',text:'Could we package in the afternoon instead? The line is booked for Pale ale in the morning.',replies:2},
    {id:'p4',author:'Sam Hughes',initials:'SH',time:'09:25',text:'I can help after lunch.',reaction:'👍 2'},
    {id:'p5',author:'Ryan White',initials:'RW',time:'09:32',text:'That could work. Let’s check the team’s availability before confirming.'},
    {id:'p6',author:'Jess Carter',initials:'JC',time:'09:34',text:'Cleaning is booked until 13:00.'},
    {id:'p7',author:'Jess Carter',initials:'JC',time:'09:35',text:'Maintenance starts at 16:00, so we need to finish before then.'},
    {id:'p8',author:'Beau Neunuebel',initials:'BN',time:'09:36',text:'I’ll check the team. The new booking is still unconfirmed.'}
  ]},
  artwork:{title:'Artwork for samples',date:'Tuesday 22 September',context:'Can artwork · v3',messages:[
    {id:'a1',author:'Ryan White',initials:'RW',time:'09:05',text:'Only use a version marked ready. A newer working file does not replace the reviewed version.',pinned:true},
    {id:'a2',author:'Sam Hughes',initials:'SH',time:'09:10',text:'The distributor sample pack needs the reviewed artwork.'},
    {id:'a3',author:'Sam Hughes',initials:'SH',time:'09:29',text:'Can we use artwork v3 for the sample pack?',replies:2},
    {id:'a4',author:'Ryan White',initials:'RW',time:'09:30',text:'I’ll review the latest version this morning.'},
    {id:'a5',author:'Jess Carter',initials:'JC',time:'09:31',text:'The small text needs a little more breathing room.',reaction:'👀 2'},
    {id:'a6',author:'Ryan White',initials:'RW',time:'09:32',text:'Please hold off using it until it is marked ready.'},
    {id:'a7',author:'Sam Hughes',initials:'SH',time:'09:34',text:'Understood. I’ll hold the sample pack.'},
    {id:'a8',author:'Jess Carter',initials:'JC',time:'09:36',text:'These review messages refer to version 3.'}
  ]},
  trade:{title:'Trade pack review',date:'Monday 21 September',context:'Trade pack · v2',messages:[
    {id:'t1',author:'Sam Hughes',initials:'SH',time:'14:10',text:'Version 2 is ready for review.'},
    {id:'t2',author:'Ryan White',initials:'RW',time:'14:30',text:'Reviewed the details in version 2. They look right.'},
    {id:'t3',author:'Sam Hughes',initials:'SH',time:'14:35',text:'Use version 2 for the trade pack. It is marked ready to use.',pinned:true}
  ]}
};
function chatMessage(key,message,{link},inline=false){
  const href=`${link('conversation')}&thread=${key}#message-${message.id}`;
  return `<article class="chat-message" id="${inline?'inline-':''}message-${message.id}" data-message-id="${message.id}"><span class="chat-avatar">${message.initials}</span><div class="chat-message-body"><div class="chat-message-meta"><strong>${message.author}</strong><time>${message.time}</time><button data-sheet="message-actions" data-pinned="${Boolean(message.pinned)}" aria-label="Actions for ${message.author} at ${message.time}">···</button></div><p>${message.text}</p>${message.reaction||message.replies?`<div class="message-feedback">${message.reaction?`<button class="reaction" data-sheet="message-reactions">${message.reaction}</button>`:''}${message.replies?`<a class="thread-replies" href="${href}" ${inline?'':'data-sheet="message-thread"'}>${message.replies} replies</a>`:''}</div>`:''}</div></article>`;
}
function pinnedMessages(key,{link}){
  const pins=chatThreads[key].messages.filter(m=>m.pinned);
  return `<aside class="shared-pins" aria-label="Pinned messages"><div class="pin-heading"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 2h6l-1 5 3 3v2H5v-2l3-3-1-5Z M10 12v6"/></svg>Pinned for everyone <span>${pins.length}</span></div>${pins.map(m=>`<a href="${link('conversation')}&thread=${key}#message-${m.id}" data-pinned-message="${m.id}"><strong>${m.author}</strong><p>${m.text}</p><small>Go to message ↗</small></a>`).join('')}</aside>`;
}
function chatComposer(key,{icon},inline=false){
  return `<div class="chat-compose"><label class="sr-only" for="${inline?'inline-':''}compose-${key}">Message ${chatThreads[key].title}</label><textarea id="${inline?'inline-':''}compose-${key}" rows="2" placeholder="Message ${chatThreads[key].title.toLowerCase()}…"></textarea><div class="compose-tools"><button data-sheet="compose-tools" aria-label="Link a file or record">${icon('plus')}</button><button data-sheet="compose-tools" aria-label="Format message">Aa</button><button data-sheet="compose-tools" aria-label="Mention a person">@</button><button data-sheet="compose-tools" aria-label="Add emoji">☺</button><button class="send-message" data-sheet="compose" aria-label="Send message">${icon('arrow')}</button></div></div>`;
}
function itemChat(key,helpers){
  const thread=chatThreads[key],recent=thread.messages.slice(-6);
  return `<section class="item-chat" data-thread="${key}"><div class="section-head"><h2>Chat</h2><a href="${helpers.link('conversation')}&thread=${key}">Open chat ${helpers.icon('chevron')}</a></div><p class="chat-context">${thread.context}</p>${discussionPreview(key,helpers,true)}${pinnedMessages(key,helpers)}<div class="recent-heading">${thread.messages.length>6?'Latest 6 of '+thread.messages.length:thread.messages.length} messages</div><div class="recent-messages">${recent.map(m=>chatMessage(key,m,helpers,true)).join('')}</div>${chatComposer(key,helpers,true)}</section>`;
}
function fullChat(key,helpers){
  const {icon,link}=helpers,thread=chatThreads[key];
  const artwork=key==='artwork',trade=key==='trade';
  const recordHref=trade?`${link('asset')}&item=trade`:`${link('task')}&item=${artwork?'artwork':'packaging'}`;
  return `<div class="chat-title"><span class="channel-symbol">#</span><h1>${thread.title}</h1><button class="conversation-star" data-sheet="star-conversation" aria-label="Star conversation">☆</button></div><p class="subtitle">${trade?'Sam, Ryan':'Ryan, Beau, Sam, Jess'} · ${thread.context}</p><a class="chat-record-link" href="${recordHref}">${icon(trade?'resources':'work')}${trade?'Trade pack · v2':artwork?'Approve can artwork':'Confirm packaging slot'}${icon('chevron')}</a>${pinnedMessages(key,helpers)}<div class="chat-date-divider"><span>${thread.date}</span></div><div class="conversation-messages">${thread.messages.map(m=>chatMessage(key,m,helpers)).join('')}</div>${artwork?`<a class="chat-record-link" href="${link('asset')}&item=artwork">${icon('resources')}Can artwork · v3 ${icon('chevron')}</a>`:trade?'':`<a class="chat-record-link" href="${link('timeline')}">${icon('calendar')}Packaging line · 1 October ${icon('chevron')}</a>`}${chatComposer(key,helpers)}`;
}
