"""Owner-approved concepts projected into the existing wiki graph."""
COLORS={'project':'#06b6d4','capability':'#3b82f6','interest':'#a855f7','value':'#ec4899',
        'goal':'#22c55e','place':'#f97316','person':'#64748b'}


def enrich_graph(graph,memory,agent_id=None):
    nodes=[dict(n) for n in graph['nodes']]; links=list(graph['links'])
    hub_id=f'_custom/{agent_id}' if agent_id else '_memory/person'
    person=memory.get('person') or {}
    name=person.get('display_name') or 'You'
    hub=next((n for n in nodes if n['id']==hub_id),None)
    if hub is None:
        hub=dict(id=hub_id,group='hub',color='#06b6d4',size=14,agentId=agent_id)
        nodes.append(hub)
    # Identity comes from persisted signup/profile data, never the language model.
    wiki=memory.get('wiki',{}) if memory.get('wiki_status')=='ready' else {}
    hub.update(label=name,agentName=name,photoUrl=person.get('photo_url'),privateMemory=True,
        markdown=f'# {name}\n\n'+(wiki.get('overview') or 'Review your private interpretations to build this wiki. Your approved projects, interests and goals will appear here.'))
    approved={i['id']:i for i in memory.get('insights',[]) if i.get('review') in ('confirm','correct')}
    keys={}
    for c in wiki.get('concepts',[]):
        if not c.get('insight_ids') or not set(c['insight_ids'])<=approved.keys():continue
        nid='_memory/concept/'+c['id'];keys[c['key']]=nid
        md=f"# {c['label']}\n\n{c['summary']}\n\n## Basis\nBased on your approved interpretations:\n"
        md+='\n'.join(f"- {approved[r]['title']} — evidence observed {approved[r]['observed_at'][:10]}" for r in c['insight_ids'])
        nodes.append(dict(id=nid,label=c['label'],group='topic',color=COLORS.get(c['kind'],'#64748b'),size=7,
            agentId=agent_id,agentName=name,privateMemory=True,markdown=md,conceptKind=c['kind']))
        links.append(dict(source=hub_id,target=nid))
    for edge in wiki.get('connections',[]):
        if edge['source'] in keys and edge['target'] in keys and set(edge['insight_ids'])<=approved.keys():
            links.append(dict(source=keys[edge['source']],target=keys[edge['target']],relation=edge['relation']))
    photos=dict(graph.get('photos',{}))
    if person.get('photo_url') and agent_id:photos[agent_id]=person['photo_url']
    return {**graph,'nodes':nodes,'links':links,'photos':photos}
