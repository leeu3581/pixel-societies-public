"""Authored connections to the existing world roster for the presentation flow.

Profile facts are drawn from the committed personality wikis. These are not
new accounts or claims that those people have published discovery signals.
"""
from .analysis import digest

ROSTER = [
    dict(canonical_id='support', name='Joon', photo_url='/profiles/joon.jpg',
         headline='Virtual worlds, digital twins & the people inside them',
         relationship='shared_direction', bridge='Worlds that understand people',
         own_label='A working experience', peer_label='Living virtual worlds',
         keywords=['world', 'agent', 'twin', 'prototype', 'functional', 'character'],
         focus=['Digital twins', 'Agent interactions', 'Market validation'],
         bio='Joon is building askmy.world: virtual environments with agent interactions and digital clones. He cares about getting an idea into people’s hands early enough to learn what makes it worth returning to.',
         their_signal='I’m building askmy.world, a virtual world with agent-based interactions and digital clone technology. I prioritise rapid implementation and market validation over extended planning.',
         reason='You’re bringing an idea into a working experience; Joon is doing that with virtual worlds and digital twins. The interesting overlap is what happens after the prototype works: what makes someone recognise themselves in it, and want to come back?',
         next_step='What is the smallest moment in a digital world that makes someone feel understood enough to return?',
         possibility='Compare one first-use journey from each project. Pick the moment that should make a new visitor want a second session.',
         contribution='A neighbouring product perspective on digital identity, agent interactions and launching early.',
         discussion=['What makes a twin feel like you?', 'First-session value', 'A reason to return']),
    dict(canonical_id='product', name='Nat', photo_url='/profiles/nat.jpg',
         headline='Research, sharp questions & evidence that earns the claim',
         relationship='complementary_strengths', bridge='From inference to useful insight',
         own_label='Interpreting real activity', peer_label='Testing the underlying claim',
         keywords=['inference', 'evidence', 'interpret', 'memory', 'test', 'question', 'increment'],
         focus=['Problem framing', 'Quality of evidence', 'Changing your mind'],
         bio='Nat is a researcher, essayist and consultant who works on the structure of difficult questions. Their strength is finding the assumption a compelling explanation depends on—and asking what would actually support it.',
         their_signal='I map the structure of a problem before jumping to solutions. I pressure-test the load-bearing claim and distinguish a real change in someone’s thinking from a new description of an old belief.',
         reason='A useful interpretation has to do more than sound convincing. Nat brings a way to pressure-test the claims in your work: which are supported, which are guesses, and which would actually change a decision. That could make your next iteration more informative, not just more polished.',
         next_step='If we took one output from my project, what evidence would convince you it was useful rather than just plausible?',
         possibility='Bring three outputs or product decisions. Together, define one concrete check that would make each worth trusting.',
         contribution='A research lens for clearer claims, better questions and tests that distinguish progress from convincing presentation.',
         discussion=['What would change our minds?', 'Signal versus story', 'One meaningful quality check']),
    dict(canonical_id='engineering', name='Yuri', photo_url='/profiles/yuri.png',
         headline='Photography, visual storytelling & knowing what to leave out',
         relationship='complementary_strengths', bridge='Make the idea visible',
         own_label='A complex product story', peer_label='Visual attention & restraint',
         keywords=['visual', 'graph', 'photo', 'demo', 'design', 'flow', 'prototype', 'interface'],
         focus=['Visual storytelling', 'Attention & detail', 'Creative restraint'],
         bio='Yuri is a photographer and painter who works through light, texture and sequence. They notice which detail carries the meaning and which detail distracts from it, and are working on translating that instinct into language others can use.',
         their_signal='I’m a photographer and painter. I work on noticing which detail carries the meaning, recognising when restraint works, and translating visual instincts into language other people can use.',
         reason='Getting the flow working and making its meaning visible are different jobs. Yuri’s eye for detail and restraint could help you find the one visual moment that explains the product—especially where a graph, image or transition is currently doing too much.',
         next_step='If I showed you the experience without explaining it, which moment would you keep—and what would you remove?',
         possibility='Walk through the product once with no narration. Compare what Yuri noticed with what you wanted them to understand.',
         contribution='A maker’s perspective on visual hierarchy, sequence and the single detail that makes an idea legible.',
         discussion=['One clear visual moment', 'Showing instead of explaining', 'What can we leave out?']),
]


def connections(mine):
    """Personalise the evidence anchor while keeping authored profile facts stable."""
    if not mine:
        return []
    result=[]
    for profile in ROSTER:
        def relevance(row):
            text=(row['body']+' '+row.get('title','')).casefold()
            return sum(term in text for term in profile['keywords'])
        own=max(mine,key=relevance)
        item={k:v for k,v in profile.items() if k!='keywords'}
        item.update(id='roster-'+digest([profile['canonical_id'],str(own['id']),own['body']]),
            purpose='conversation' if profile['relationship']=='shared_direction' else 'collaboration',
            your_signal=own['body'],own_label=(own.get('title') or 'Your current focus')[:40],
            your_topics=list(own['topics'])[:3],availability='',feedback=None,
            expires_at=own['expires_at'],curated=True,
            uncertainty='A starting point for a conversation; interest and availability are still yours to explore.')
        result.append(item)
    return result
