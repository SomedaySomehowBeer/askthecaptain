// Documentation fixtures: saved views select the same illustrative records.
function taggedWork(name,{icon,link,task,head}) {
  const production=name==='Production';
  const rows=production
    ?task('Confirm packaging slot','production','Production','Summer lager','Today',true)+task('Prepare distributor samples','production','Production · Sales','Summer lager','Thu 24')
    :task('Approve can artwork','marketing','Marketing','Summer lager','Today')+task('Plan October content','marketing','Marketing','October content','Fri 25');
  return `<div class="title-row"><h1>${name}</h1><button class="plus" data-sheet="new" aria-label="Add task">${icon('plus')}</button></div>
    <p class="subtitle">A saved view of shared work.</p>
    <div class="filter-row"><button class="selected" data-sheet="work-filter">Tag: ${name} ${icon('down')}</button><button data-sheet="work-filter">Anyone ${icon('down')}</button><button data-sheet="work-filter">Open ${icon('down')}</button><button data-sheet="work-mode">List ${icon('down')}</button></div>
    ${head('Open tasks','<span class="count">2 tasks</span>')}<div class="card">${rows}</div>
    ${head('Related project')}<a class="linked-record" href="${link('project')}"><span class="record-icon">${icon('work')}</span><span><strong>Summer lager launch</strong><small>Open the whole project</small></span>${icon('chevron')}</a>
    ${head('Related resources')}<div class="resource-list">${production?`<a href="${link('timeline')}">${icon('calendar')}<span><strong>Equipment schedule</strong><small>Availability across every project</small></span>${icon('chevron')}</a><a href="${link('inventory')}">${icon('resources')}<span><strong>Inventory</strong><small>Materials and finished stock</small></span>${icon('chevron')}</a>`:`<a href="${link('files')}">${icon('resources')}<span><strong>Files & assets</strong><small>Shared library · Summer lager collection</small></span>${icon('chevron')}</a>`}</div>
    <p class="tiny-note">${production?'Tasks can carry more than one tag. The equipment schedule includes other people’s bookings.':'Change tags, assignee or project to see another selection of the same work.'}</p>`;
}

function sectionViews({icon,link,head}) {
  const row=(label,detail,screen,symbol='work',selected=false,sheet='planned-view')=>`<${screen?'a':'button'} ${screen?`href="${link(screen)}"`:`data-sheet="${sheet}"`} class="view-row${selected?' current-view':''}"><span class="view-icon">${icon(symbol)}</span><span><strong>${label}</strong><small>${detail}</small></span>${selected?'<span class="view-check" aria-label="Default view">✓</span>':icon('chevron')}</${screen?'a':'button'}>`;
  const group=(name,rows)=>`${head(name)}<div class="card view-group">${rows}</div>`;
  const content={
    work:group('For you',row('My work','Assigned to you · Open','work','work',true)+row('Upcoming','Your work by date',null,'calendar'))+
      group('Across the business',row('All tasks','Anyone · All tags · Open','all-work')+row('Projects','Shared outcomes across the team',null,'work',false,'project-list'))+
      group('Saved views',row('Production','Tag: Production · Anyone','production','tank')+row('Marketing','Tag: Marketing · Anyone','marketing','megaphone')+row('Sales','Tag: Sales · Anyone',null,'sales')+row('Admin & reporting','Tag: Admin · Anyone',null,'admin')),
    chat:group('Inbox',row('All conversations','Team and linked work discussions','chat','chat',true)+row('Unread','2 conversations',null,'chat')+row('Starred','Your bookmarked conversations',null,'chat'))+
      group('Projects',row('Packaging slot',`Summary: ${discussionPreviews.packaging.summary} Through ${discussionPreviews.packaging.through}.`,'conversation','work'))+
      group('Team',row('General',`Summary: ${discussionPreviews.general.summary} Through ${discussionPreviews.general.through}.`,null,'chat')),
    resources:group('Libraries',row('Files & assets','Collections, versions and review','files','resources',true)+row('Inventory','Ingredients, consumables and finished stock','inventory','sales'))+
      group('Planning',row('Equipment schedule','Bookings, availability and maintenance','timeline','calendar'))+
      group('Business',row('People','People and their assigned work',null,'work')+row('Reports','Business performance and evidence',null,'admin'))
  };
  return ['work','chat','resources'].map(section=>({
    id:section==='resources'?'resource-views':section+'-views',active:section,
    // No visible page title: section identity is carried by the selected bottom tab.
    breadcrumb:'<span></span>',title:section[0].toUpperCase()+section.slice(1)+' · View list',
    caption:'One page to the left of the selected view; choose a group or saved filter.',
    content:`<h1 class="sr-only">${section} views</h1>${content[section]}`
  }));
}
