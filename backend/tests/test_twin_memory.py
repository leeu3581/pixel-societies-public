import asyncio
import copy
from datetime import datetime, timezone
from app.twin_memory.analysis import evidence_from_sources, normalize_interpretation
from app.twin_memory.models import Interpretation, Insight
from app.twin_memory.service import reconcile_reviews, strip_imported_memory
from app.twin_memory.discovery import opportunity
NOW=datetime(2026,11,3,tzinfo=timezone.utc)
def source(text='I need help with streaming latency before Friday.',kind='manual',id='a'):
    return {'id':id,'kind':kind,'created_at':NOW.isoformat(),'payload':{'text':text,'kind':'need'}}
def claim(ref='e1',kind='need'):
    return Insight(kind=kind,title='Reduce streaming latency',summary='Needs help reducing streaming latency before a demo.',evidence_ids=[ref],confidence='medium',uncertainty='The current latency target has not been confirmed.',topics=['streaming latency'],next_step='Ask about the latency target.')
def test_duplicate_evidence_has_one_identity_with_multiple_sources():
    items=evidence_from_sources([source(id='a'),source(id='b')]);assert len(items)==1 and items[0]['source_ids']==['a','b']
def test_fabricated_citations_discarded_and_old_needs_historical():
    ev=[{'id':'e1','observed_at':'2025-01-01T00:00:00+00:00','source_ids':['a']}]
    result=normalize_interpretation(Interpretation(insights=[claim(),claim('invented')]),ev,NOW)
    assert len(result['insights'])==1 and result['insights'][0]['status']=='historical'
def test_redaction_and_no_assistant_attribution():
    s=source('Contact me at private@example.test. API_KEY=secret123');items=evidence_from_sources([s])
    assert 'private@example.test' not in items[0]['text'] and 'secret123' not in items[0]['text']
    s['kind']='claude_code';s['payload']={'profile':{},'excerpts':[{'role':'assistant','text':'The user is a brilliant leader','ts':NOW.isoformat()}]}
    assert evidence_from_sources([s])==[]
def test_legacy_recovers_dated_human_prose():
    import json
    s=source(kind='legacy');s['payload']={'text':'### Selected human voice and intentions\n'+json.dumps([{'role':'user','text':'I need help profiling audio latency.','ts':'2026-11-02T00:00:00Z','project':'Voice'}])}
    e=evidence_from_sources([s])[0];assert e['authorship']=='user_statement' and e['observed_at']=='2026-11-02T00:00:00Z'
def test_correction_wins_over_reworded_claim_and_deletion_wins_over_correction():
    original=normalize_interpretation(Interpretation(insights=[claim()]),[{'id':'e1','observed_at':NOW.isoformat(),'source_ids':['a']}],NOW)['insights'][0]
    changed=copy.deepcopy(original);changed['id']='changed';changed['summary']='A reworded misunderstanding.'
    snapshot={'evidence':[{'id':'e1'}],'insights':[changed]}
    reviews={original['id']:{'action':'correct','insight':original,'summary':'Actually I need help measuring latency first.','at':NOW.isoformat()}}
    out=reconcile_reviews(snapshot,reviews);assert len(out['insights'])==1 and out['insights'][0]['summary'].startswith('Actually')
    reviews[original['id']]['action']='dismiss';assert reconcile_reviews(snapshot,reviews)['insights']==[]
    assert reconcile_reviews({'evidence':[],'insights':[]},reviews)['insights']==[]
def test_private_persona_stripping_fails_closed():
    assert strip_imported_memory('Voice\n<!-- claude-code-memory:start -->secret<!-- claude-code-memory:end -->\nAfter')=='Voice\n\nAfter'
    assert strip_imported_memory('Voice\n<!-- claude-code-memory:start -->secret')=='Voice'
def signal(kind,purpose='help',topics=None):return {'kind':kind,'purpose':purpose,'topics':topics or ['streaming latency']}
def test_need_capability_without_role_penalty_and_no_stack_only_matches():
    assert opportunity(signal('need'),signal('capability'))
    assert opportunity(signal('offer'),signal('need'))
    assert opportunity(signal('interest'),signal('interest')) is None
    assert opportunity(signal('need'),signal('offer',topics=['billing'])) is None
    assert opportunity(signal('intent','cofounder'),signal('intent','cofounder'))
    assert opportunity(signal('capability','cofounder'),signal('intent','cofounder')) is None
def test_private_chat_never_loads_memory_for_visitors(monkeypatch):
    from app.twin_memory import service
    async def forbidden(*args):raise AssertionError('private read')
    monkeypatch.setattr(service,'view',forbidden)
    assert asyncio.run(service.private_chat_context('owner','visitor','public'))=='public'


def test_wiki_only_projects_approved_concepts_and_persisted_identity():
    from app.twin_memory.graph import enrich_graph
    public={'nodes':[{'id':'_custom/twin','label':'Old test name','group':'hub','size':12}], 'links':[]}
    original=copy.deepcopy(public)
    approved={'id':'i1','review':'confirm','title':'Long inference title','observed_at':NOW.isoformat()}
    memory={'person':{'display_name':'Saved name','photo_url':'/stored/original.jpg'},'insights':[approved],
        'wiki_status':'ready','wiki':{'overview':'Builds tools.', 'concepts':[{'id':'c1','key':'project','label':'Pixel Societies','kind':'project','summary':'A current project.','insight_ids':['i1']}], 'connections':[]}}
    result=enrich_graph(public,memory,'twin')
    assert public==original
    assert result['nodes'][0]['label']=='Saved name'
    assert result['nodes'][0]['photoUrl']=='/stored/original.jpg'
    assert result['nodes'][1]['label']=='Pixel Societies'
    assert len(result['links'])==1
    memory['insights'][0]['review']='unreviewed'
    assert len(enrich_graph(public,memory,'twin')['nodes'])==1


def test_wiki_rejects_unknown_citations_and_sentence_labels():
    from app.twin_memory.wiki import Wiki,Concept,Connection,normalize
    def concept(key,label,refs):
        return Concept(key=key,label=label,kind='project',summary='A supported project.',insight_ids=refs)
    output=Wiki(concepts=[concept('valid','Pixel Societies',['i1']),concept('fake','London',['unknown']),
        concept('long','This is a full sentence about work',['i1'])],
        connections=[Connection(source='valid',target='fake',relation='based in',insight_ids=['i1'])])
    result=normalize(output,[{'id':'i1'}])
    assert [c['label'] for c in result['concepts']]==['Pixel Societies']
    assert result['connections']==[]


def test_semantic_matching_validates_published_references_and_excludes_private_fields():
    from app.twin_memory.matching import Fits,Fit,validate_fits,published_parts
    own={'id':'own','owner_user_id':'a','kind':'workstream','body':'Building a tool.','topics':[], 'private_evidence':'secret'}
    peer={**own,'id':'peer','owner_user_id':'b'}
    assert 'private_evidence' not in published_parts([own])[0]
    valid=Fit(own_id='own',peer_id='peer',kind='conversation',relationship='complementary_strengths',bridge='Testing the workflow',own_label='New prototype',peer_label='Workflow testing',reason='Compare the tool with the research.',next_step='Discuss one workflow.',uncertainty='Interest is unknown.')
    bad=valid.model_copy(update={'peer_id':'invented'})
    fits=validate_fits(Fits(connections=[valid,bad]),[own],[peer])
    assert list(fits)==[('own','peer')]
    assert fits[('own','peer')]['relationship']=='complementary_strengths'
    assert fits[('own','peer')]['bridge']=='Testing the workflow'


def test_graph_waits_for_synthesized_concepts():
    from app.twin_memory.graph import enrich_graph
    m={'insights':[{'id':'a','review':'correct','title':'Original'}], 'wiki_status':'building',
       'signals':[{'insight_id':'a','title':'Small steps','body':'I build and test in small steps.'}]}
    graph={'nodes':[],'links':[]}
    assert len(enrich_graph(graph,m)['nodes'])==1
    m['wiki_status']='ready'
    m['insights'][0]['observed_at']='2026-11-04'
    m['wiki']={'concepts':[dict(id='iterative',key='iteration',label='Incremental development',kind='capability',summary='Testing each small step.',insight_ids=['a'])]}
    assert enrich_graph(graph,m)['nodes'][1]['label']=='Incremental development'
    m['wiki']={}
    m['signals']=[]
    assert len(enrich_graph(graph,m)['nodes'])==1


def test_publication_drafts_reject_unknown_ids_and_long_labels():
    import pytest
    from app.twin_memory.publication import Drafts, validate_drafts
    item={'id':'a','label':'Small steps','text':'For this project I work in small steps.','section':'approach','reading':'You build in small steps'}
    assert validate_drafts(Drafts(items=[item]),[{'id':'a'}])==[item]
    for bad in [{**item,'id':'other'},{**item,'label':'A very long label with many words'}]:
        with pytest.raises(ValueError): validate_drafts(Drafts(items=[bad]),[{'id':'a'}])


def test_roster_connections_use_existing_people_and_exact_owner_evidence():
    from app.twin_memory.roster_connections import connections
    rows=[dict(id='a',title='Living worlds',body='I am building a virtual world with digital twins.',topics=['digital twins'],expires_at='2026-12-01'),
          dict(id='b',title='Evidence quality',body='I want to test the evidence behind each interpretation.',topics=['evidence'],expires_at='2026-12-01')]
    before=copy.deepcopy(rows)
    result=connections(rows)
    assert [i['name'] for i in result]==['Joon','Nat','Yuri']
    assert {i['relationship'] for i in result}=={'shared_direction','complementary_strengths'}
    assert all(i['your_signal'] in {r['body'] for r in rows} for i in result)
    assert result[0]['your_signal']==rows[0]['body']
    assert result[1]['your_signal']==rows[1]['body']
    assert all(i['bio'] and i['possibility'] and i['focus'] for i in result)
    assert 'photographer' in result[2]['bio']
    assert connections([])==[] and rows==before
    assert result[0]['id']==connections(rows)[0]['id']
