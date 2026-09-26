import { createFileRoute, Link } from '@tanstack/react-router';
import {
  type CSSProperties,
  Fragment,
  type ReactElement,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
  useState,
} from 'react';
import { SitePage, useSignedIn } from '../components/site/chrome.tsx';
import { COMMAND_SET } from '../components/site/command-set.gen.ts';
import { DashboardShot } from '../components/site/landing-dashboard.tsx';
import {
  ChannelList,
  ChatButton,
  ChatCode,
  ChatCodeBlock,
  ChatContainer,
  ChatEmbed,
  ChatHeader,
  ChatHeading,
  ChatImage,
  ChatLink,
  ChatMessage,
  ChatRow,
  ChatSeparator,
  ChatSubtext,
  ChatText,
  ChatThinking,
  ChatTime,
  ChatWindow,
  Composer,
  Mention,
  ServerRail,
  StatusEmbed,
  type StatusKind,
} from '../components/site/landing-discord.tsx';
import { cx } from '../components/ui/controls.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { MODULE_BY_ID, MODULES, NAV_GROUPS } from '../lib/modules/catalogue.ts';

export const Route = createFileRoute('/')({
  component: Landing,
});

let heroEntered = false;

function Actions({ signedIn }: { signedIn: boolean | null }): ReactElement {
  return (
    <div className="landing-actions">
      <a href="/invite" className="landing-cta">
        <Icon name="discord-logo" size={18} weight="fill" />
        Add to Discord
      </a>
      <Link
        to={signedIn === true ? '/dashboard' : '/signin'}
        className="button button-secondary button-lg landing-secondary"
      >
        Open the dashboard
      </Link>
    </div>
  );
}

function HeroShot({ figureRef }: { figureRef: Ref<HTMLElement> }): ReactElement {
  return (
    <figure className="landing-shot" ref={figureRef}>
      <div className="landing-frame">
        <div className="dc landing-window landing-window-main">
          <ServerRail active="Northwind" />
          <ChannelList
            server="Northwind"
            user={{ name: 'mira', tone: 'pink' }}
            groups={[
              { name: 'Information', channels: [{ name: 'rules' }, { name: 'announcements' }] },
              {
                name: 'Community',
                channels: [{ name: 'general', active: true }, { name: 'roles' }, { name: 'clips' }],
              },
              { name: 'Support', channels: [{ name: 'tickets' }] },
              { name: 'Staff', channels: [{ name: 'mod-log' }] },
            ]}
          />
          <div className="landing-chat">
            <ChatHeader channel="general" topic="Say hi. Keep it kind." />
            <div className="landing-messages">
              <ChatMessage proton time="Today at 9:41 PM">
                <ChatText>
                  Welcome to Northwind, <Mention>@kai</Mention>. You are member #1283.
                </ChatText>
              </ChatMessage>
              <ChatMessage author="kai" tone="green" time="Today at 9:42 PM">
                <ChatText>hey everyone, glad to be here</ChatText>
              </ChatMessage>
              <ChatMessage proton time="Today at 9:44 PM">
                <ChatText>
                  <Mention>@ren</Mention> reached level 12.
                </ChatText>
              </ChatMessage>
            </div>
            <Composer channel="general" />
          </div>
        </div>
      </div>

      <ChatWindow channel="mod-log" className="landing-window-log">
        <ChatMessage proton time="Today at 9:43 PM">
          <ChatEmbed
            color="#4fcf95"
            title="🍯 Honeypot triggered"
            description={<ChatLink>Jump to the message</ChatLink>}
            fields={[
              {
                name: 'Member',
                value: (
                  <>
                    <Mention>@nitro.drop</Mention>
                    {'\n'}
                    <ChatCode>1150384920117248</ChatCode>
                  </>
                ),
                inline: true,
              },
              { name: 'Channel', value: <Mention>#welcome-bonus</Mention>, inline: true },
              { name: 'Action', value: 'Softban', inline: true },
              { name: 'Messages deleted', value: 'The last day', inline: true },
              { name: 'Result', value: 'Done', inline: true },
            ]}
            footer="Today at 9:43 PM"
          />
        </ChatMessage>
        <ChatMessage proton continued>
          <ChatText>
            <strong>Raid detected.</strong> 14 accounts joined within 10s, at or above this server's
            raid threshold of 10. New members scoring 4/5 or higher are being given the verification
            role.
          </ChatText>
        </ChatMessage>
      </ChatWindow>

      <figcaption className="landing-caption">
        An illustrative server. Names and messages are examples.
      </figcaption>
    </figure>
  );
}

function SecurityShot(): ReactElement {
  return (
    <ChatWindow channel="mod-log" className="landing-window-card">
      <ChatMessage proton time="Today at 3:12 AM">
        <ChatText>
          Anti-Nuke tripped: 6 channel deletions within 10s by <Mention>@vex</Mention> (limit 5 per
          10s).{'\n'}
          Removed 3 of their 3 roles: <Mention>@Admin</Mention>, <Mention>@Moderator</Mention>,{' '}
          <Mention>@Helper</Mention>. Each removal is recorded as a case with the full role list, so
          their roles can be restored exactly.{'\n'}
          They were then banned from this server.
        </ChatText>
      </ChatMessage>
      <ChatMessage proton time="Today at 3:40 AM">
        <ChatText>
          Phishing link detected in <Mention>#general</Mention>.{'\n'}
          Author: <Mention>@free.gifts</Mention>
          {'\n'}
          Link host: <ChatCode>gift.example</ChatCode>, matching <ChatCode>gift.example</ChatCode>{' '}
          on the community phishing blocklist.{'\n'}
          Message: <ChatLink>https://discord.com/channels/1204/5531/8812</ChatLink> (still up, so
          delete it by hand){'\n'}
          Action: timed out for 1d. If the link is safe, add <ChatCode>gift.example</ChatCode> to
          Allowed domains in the Proton dashboard.
        </ChatText>
      </ChatMessage>
    </ChatWindow>
  );
}

function ModerationShot(): ReactElement {
  return (
    <ChatWindow channel="staff" className="landing-window-card">
      <ChatMessage
        proton
        time="Today at 6:02 PM"
        command={{ user: 'mira', name: 'warn', tone: 'pink' }}
        ephemeral
      >
        <StatusEmbed kind="success">
          Warned <Mention>@kai</Mention>.
          <ChatSubtext>
            Case <ChatCode>Kq3xT9a</ChatCode>
          </ChatSubtext>
        </StatusEmbed>
      </ChatMessage>
      <ChatMessage proton time="Today at 7:15 PM">
        <ChatContainer accent="#f0b752">
          <ChatHeading level={2}>Appeal #12</ChatHeading>
          <ChatText>
            <strong>Ban appeal</strong> · <Mention>@drift</Mention>
          </ChatText>
          <ChatText>
            <strong>Why should the ban be lifted?</strong>
          </ChatText>
          <ChatCodeBlock>
            My account was taken over and posted a scam link. It’s secured now.
          </ChatCodeBlock>
          <ChatSeparator />
          <ChatRow>
            <ChatButton tone="success">Accept</ChatButton>
            <ChatButton tone="danger">Turn down</ChatButton>
          </ChatRow>
        </ChatContainer>
      </ChatMessage>
    </ChatWindow>
  );
}

function useLater(): (run: () => void, ms: number) => void {
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);

  return (run, ms) => {
    timers.current.push(window.setTimeout(run, ms));
  };
}

interface Reply {
  id: number;
  kind: StatusKind;
  text: ReactNode;
  ready: boolean;
}

function useReplies(): {
  replies: readonly Reply[];
  reply: (kind: StatusKind, text: ReactNode, thinking?: boolean) => void;
  dismiss: (id: number) => void;
} {
  const later = useLater();
  const next = useRef(0);
  const [replies, setReplies] = useState<readonly Reply[]>([]);

  const reply = (kind: StatusKind, text: ReactNode, thinking = true): void => {
    next.current += 1;
    const id = next.current;
    setReplies((list) => [...list.slice(-1), { id, kind, text, ready: !thinking }]);
    if (!thinking) return;

    later(() => {
      setReplies((list) => list.map((item) => (item.id === id ? { ...item, ready: true } : item)));
    }, 900);
  };

  const dismiss = (id: number): void => {
    setReplies((list) => list.filter((item) => item.id !== id));
  };

  return { replies, reply, dismiss };
}

function Replies({
  replies,
  dismiss,
  time,
}: {
  replies: readonly Reply[];
  dismiss: (id: number) => void;
  time: string;
}): ReactElement {
  return (
    <>
      {replies.map((item) => (
        <ChatMessage
          proton
          time={time}
          ephemeral={{ onDismiss: () => dismiss(item.id) }}
          key={item.id}
        >
          {item.ready ? <StatusEmbed kind={item.kind}>{item.text}</StatusEmbed> : <ChatThinking />}
        </ChatMessage>
      ))}
    </>
  );
}

const PRESS_WINDOW_MS = 3000;

function CommunityShot(): ReactElement {
  const later = useLater();
  const { replies, reply, dismiss } = useReplies();
  const [entries, setEntries] = useState(148);
  const [entered, setEntered] = useState(false);
  const lastPress = useRef(0);

  const enter = (): void => {
    const now = Date.now();
    if (now - lastPress.current < PRESS_WINDOW_MS) {
      reply('error', 'You just pressed that. Give it a moment, then try again.');
      return;
    }
    lastPress.current = now;

    if (entered) {
      reply(
        'error',
        <>
          You’re already in the draw for <strong>Custom role colour</strong> with 1 entry.
        </>,
      );
      return;
    }

    setEntered(true);
    reply(
      'success',
      <>
        You’re in the draw for <strong>Custom role colour</strong>. Good luck.
      </>,
    );
    later(() => setEntries(149), 4000);
  };

  return (
    <ChatWindow channel="giveaways" className="landing-window-card">
      <ChatMessage proton time="Today at 12:00 PM">
        <ChatContainer accent="#5865f2">
          <ChatHeading level={1}>🎉 Custom role colour</ChatHeading>
          <ChatSeparator small />
          <ChatText>
            🏆 <strong>Winners</strong>
            {'\n'}2{'\n\n'}⏰ <strong>Ends</strong>
            {'\n'}
            <ChatTime>in 2 days</ChatTime>
            {'\n\n'}🎫 <strong>Entries</strong>
            {'\n'}
            {entries}
            {'\n\n'}👤 <strong>Hosted by</strong>
            {'\n'}
            <Mention>@mira</Mention>
          </ChatText>
          <ChatSeparator small />
          <ChatRow>
            <ChatButton emoji="🎉" onPress={enter}>
              Enter giveaway
            </ChatButton>
            <ChatButton tone="secondary" emoji="🚪">
              Leave
            </ChatButton>
          </ChatRow>
          <ChatSubtext>G-7X29</ChatSubtext>
        </ChatContainer>
      </ChatMessage>
      <Replies replies={replies} dismiss={dismiss} time="Today at 12:04 PM" />
    </ChatWindow>
  );
}

function JoiningShot(): ReactElement {
  const { replies, reply, dismiss } = useReplies();
  const [verified, setVerified] = useState(false);

  const verify = (): void => {
    if (verified) {
      reply('error', "You're already verified.", false);
      return;
    }

    setVerified(true);
    reply('success', "You're verified. Welcome in.");
  };

  return (
    <div className="landing-scene-pair">
      <ChatWindow channel="verify" className="landing-window-card">
        <ChatMessage proton time="Yesterday at 4:18 PM">
          <ChatHeading level={2}>Verify to get access</ChatHeading>
          <ChatText>Press the button below to see the rest of the server.</ChatText>
          <ChatRow>
            <ChatButton tone="success" onPress={verify}>
              Verify
            </ChatButton>
          </ChatRow>
        </ChatMessage>
        <Replies replies={replies} dismiss={dismiss} time="Today at 9:52 PM" />
      </ChatWindow>

      <ChatWindow channel="welcome" className="landing-window-card">
        <ChatMessage proton time="Today at 9:51 PM">
          <ChatText>
            Welcome to Northwind, <Mention>@Rin</Mention>. You are member #1284.
          </ChatText>
        </ChatMessage>
      </ChatWindow>
    </div>
  );
}

function TicketsShot(): ReactElement {
  const panel = useReplies();
  const room = useReplies();
  const [claimed, setClaimed] = useState(false);

  const open = (): void => {
    panel.reply(
      'success',
      <>
        Opened ticket #42 in <Mention>#ticket-42</Mention>. Only you and staff can see it.
      </>,
    );
  };

  const claim = (): void => {
    setClaimed(true);
    room.reply('success', 'You claimed ticket #42.', false);
  };

  return (
    <div className="landing-scene-pair">
      <ChatWindow channel="tickets" className="landing-window-card">
        <ChatMessage proton time="Yesterday at 2:05 PM">
          <ChatContainer accent="#3874f3">
            <ChatHeading level={2}>Support</ChatHeading>
            <ChatText>Need a hand? Open a ticket and the team will be with you.</ChatText>
            <ChatSeparator invisible small />
            <ChatRow>
              <ChatButton onPress={open}>Support</ChatButton>
            </ChatRow>
          </ChatContainer>
        </ChatMessage>
        <Replies replies={panel.replies} dismiss={panel.dismiss} time="Today at 9:12 PM" />
      </ChatWindow>

      <ChatWindow channel="ticket-42" className="landing-window-card">
        <ChatMessage proton time="Today at 9:12 PM">
          <ChatContainer accent="#3874f3">
            <ChatHeading level={2}>Ticket #42</ChatHeading>
            <ChatText>
              Thanks for getting in touch, <Mention>@kai</Mention>. Describe the problem below.
            </ChatText>
            <ChatSeparator small />
            <ChatText>
              <strong>Type</strong>
              {'\n'}Support{'\n\n'}
              <strong>Priority</strong>
              {'\n'}Medium{'\n\n'}
              <strong>Who can see this</strong>
              {'\n'}You and <Mention>@Helper</Mention>
            </ChatText>
            <ChatSeparator invisible small />
            <ChatRow>
              <ChatButton tone="danger">Close</ChatButton>
              {claimed ? (
                <ChatButton tone="secondary">Unclaim</ChatButton>
              ) : (
                <ChatButton tone="success" onPress={claim}>
                  Claim
                </ChatButton>
              )}
              <ChatButton tone="secondary">Add member</ChatButton>
              <ChatButton tone="secondary">Options</ChatButton>
            </ChatRow>
          </ChatContainer>
        </ChatMessage>
        <ChatMessage proton continued>
          <ChatText>
            <Mention>@Helper</Mention>
          </ChatText>
        </ChatMessage>
        <Replies replies={room.replies} dismiss={room.dismiss} time="Today at 9:14 PM" />
      </ChatWindow>
    </div>
  );
}

const RIN_AVATAR = '/art/author-avatar.png';

function LevelingShot(): ReactElement {
  return (
    <ChatWindow channel="general" className="landing-window-card">
      <ChatMessage author="kai" tone="green" time="Today at 8:12 PM">
        <ChatText>that last round was way too close</ChatText>
      </ChatMessage>
      <ChatMessage proton time="Today at 8:12 PM">
        <ChatText>
          <Mention>@kai</Mention> reached level 9.
        </ChatText>
      </ChatMessage>
      <ChatMessage
        proton
        time="Today at 8:15 PM"
        command={{ user: 'Rin', name: 'rank', tone: 'blurple', avatar: RIN_AVATAR }}
      >
        <ChatImage src="/art/rank-card.png" width={1100} height={370} />
      </ChatMessage>
    </ChatWindow>
  );
}

function DashboardScene(): ReactElement {
  return (
    <>
      <DashboardShot />
      <figcaption className="landing-caption">Illustrative settings.</figcaption>
    </>
  );
}

interface StoryStep {
  id: string;
  title: string;
  lede: string;
  modules: readonly string[];
  scene: () => ReactNode;
  link?: 'dashboard' | undefined;
}

const STEPS: readonly StoryStep[] = [
  {
    id: 'joining',
    title: 'New members, checked and welcomed',
    lede: 'Verification holds new members at a button, captcha or website sign-in until they pass. Join Roles gives them roles as they arrive, and Welcomer greets each one by name.',
    modules: ['verification', 'joinroles', 'welcome'],
    scene: JoiningShot,
  },
  {
    id: 'security',
    title: 'Acts on spam, raids and nukes as they happen',
    lede: 'Automod filters spam and Anti-Raid scores every join. Anti-Nuke strips roles from members making destructive changes too quickly, Phishing acts on known scam links, and Honeypot catches spam bots and hacked accounts that post in bait channels.',
    modules: ['automod', 'antiraid', 'antinuke', 'phishing', 'honeypot'],
    scene: SecurityShot,
  },
  {
    id: 'moderation',
    title: 'Every action on the record',
    lede: 'Warnings, timeouts, kicks and bans each become a numbered case. Repeat warnings escalate to the punishments you set, and Appeals collects ban appeals through a form instead of DMs.',
    modules: ['moderation', 'cases', 'appeals', 'permissions'],
    scene: ModerationShot,
  },
  {
    id: 'tickets',
    title: 'Support without the DMs',
    lede: 'Members open a private channel with your staff from a panel. Each ticket is numbered and can be claimed, and a transcript can be kept when it closes.',
    modules: ['tickets'],
    scene: TicketsShot,
  },
  {
    id: 'leveling',
    title: 'Levels, ranks and role rewards',
    lede: 'Members earn XP for messages and voice time and unlock role rewards as they climb. /rank can answer with a card showing where they stand.',
    modules: ['leveling'],
    scene: LevelingShot,
  },
  {
    id: 'community',
    title: 'Tools for your members',
    lede: 'Members pick roles from menus, enter giveaways, vote in polls and on suggestions, star messages onto a starboard and get their own voice channels.',
    modules: ['rolemenu', 'giveaways', 'polls', 'suggestions', 'starboard', 'tempvc'],
    scene: CommunityShot,
  },
  {
    id: 'dashboard',
    title: 'Set it all up in one dashboard',
    lede: 'Turn modules on and off, change their settings and search the case log. When a module can’t run, its page names the missing permission or intent.',
    modules: [],
    scene: DashboardScene,
    link: 'dashboard',
  },
];

const RAIL = '(min-width: 1001px)';

function useRail(): boolean | null {
  const [rail, setRail] = useState<boolean | null>(null);

  useEffect(() => {
    const query = window.matchMedia(RAIL);
    const update = (): void => setRail(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return rail;
}

function Story({ signedIn }: { signedIn: boolean | null }): ReactElement {
  const rail = useRail();
  const [reading, setReading] = useState(0);
  const [played, setPlayed] = useState<ReadonlySet<number>>(() => new Set());
  const [live, setLive] = useState(false);
  const shots = useRef<(Element | null)[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout swap remounts the figures, and the new nodes have to be observed
  useEffect(() => {
    const figures = shots.current;
    if (figures.length === 0 || typeof IntersectionObserver === 'undefined') return;

    setLive(true);

    const reader = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setReading(figures.indexOf(entry.target));
        }
      },
      { rootMargin: '-49% 0px -50% 0px' },
    );

    const player = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const fills =
            entry.rootBounds !== null &&
            entry.intersectionRect.height >= entry.rootBounds.height * 0.6;
          if (entry.intersectionRatio < 0.45 && !fills) continue;
          const index = figures.indexOf(entry.target);
          setPlayed((previous) => new Set(previous).add(index));
          player.unobserve(entry.target);
        }
      },
      { threshold: [0.15, 0.3, 0.45] },
    );

    for (const figure of figures) {
      if (!figure) continue;
      reader.observe(figure);
      player.observe(figure);
    }

    return () => {
      reader.disconnect();
      player.disconnect();
    };
  }, [rail]);

  const steps = STEPS.map((step, index) => {
    const open = rail !== true || index === reading;

    return (
      <div
        className="landing-story-step"
        data-reading={index === reading ? '' : undefined}
        style={{ '--step': index } as CSSProperties}
        key={step.id}
      >
        <h2 className="landing-story-title">{step.title}</h2>
        <div className="landing-story-detail">
          <div>
            <p className="landing-sub">{step.lede}</p>
            {step.modules.length > 0 ? (
              <ul className="landing-modules">
                {step.modules.map((moduleId) => {
                  const meta = MODULE_BY_ID.get(moduleId);
                  if (!meta) return null;

                  return (
                    <li key={moduleId}>
                      <Icon name={meta.icon} size={15} />
                      {meta.label}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {step.link === 'dashboard' ? (
              <Link
                to={signedIn === true ? '/dashboard' : '/signin'}
                className="landing-link landing-story-link"
                tabIndex={open ? undefined : -1}
              >
                Open the dashboard
                <Icon name="caret-right" size={13} weight="fill" />
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    );
  });

  const scenes = STEPS.map((step, index) => (
    <figure
      className="landing-story-shot"
      data-played={played.has(index) ? '' : undefined}
      style={{ '--step': index } as CSSProperties}
      ref={(node) => {
        shots.current[index] = node;
      }}
      key={`${step.id}-shot`}
    >
      <step.scene />
    </figure>
  ));

  return (
    <section
      className="landing-section landing-story"
      data-live={live ? '' : undefined}
      aria-label="What Proton does"
    >
      {rail === false ? (
        STEPS.map((step, index) => (
          <Fragment key={step.id}>
            {steps[index]}
            {scenes[index]}
          </Fragment>
        ))
      ) : (
        <>
          <div className="landing-story-rail">{steps}</div>
          <div className="landing-story-shots">{scenes}</div>
        </>
      )}
    </section>
  );
}

function Everything(): ReactElement {
  return (
    <section className="landing-band" aria-labelledby="modules">
      <div className="landing-section landing-band-inner">
        <h2 className="landing-band-title" id="modules">
          All {MODULES.length} modules in one bot
        </h2>
        <p className="landing-sub">Each one starts off. Turn on what your server needs.</p>

        <div className="landing-index">
          {NAV_GROUPS.map((group) => {
            const members = MODULES.filter((meta) => meta.group === group.id);
            if (members.length === 0) return null;

            return (
              <div className="landing-index-group" key={group.id}>
                <h3 className="landing-index-label">
                  {group.label}
                  <span className="landing-index-count">{members.length}</span>
                </h3>
                <ul>
                  {members.map((meta) => (
                    <li className="landing-index-item" key={meta.id}>
                      <span className="landing-index-tile">
                        <Icon name={meta.icon} size={16} />
                      </span>
                      <span>
                        <span className="landing-index-name">{meta.label}</span>
                        <span className="landing-index-desc">{meta.description}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

const STORED: readonly { title: string; body: string }[] = [
  {
    title: 'Logging is opt-in',
    body: 'Message logging and ticket message capture stay off until you turn them on.',
  },
  {
    title: 'Deleted after 30 days',
    body: 'Message logs are deleted after 30 days, captured ticket messages 30 days after capture, and messages kept on a moderation case 30 days after the case.',
  },
  {
    title: 'Application answers expire',
    body: 'Answers to an application are deleted 30 days after it’s decided, withdrawn or expires, unless the server sets another number of days. Unsent drafts go after 30 days without changes.',
  },
  {
    title: 'Report evidence expires',
    body: 'User reports keep the reported message, attachment links and what the reporter wrote until 30 days after the report is resolved, and never more than 90 days.',
  },
  {
    title: 'Reading isn’t keeping',
    body: 'Automod and the phishing filter read messages to decide whether to act, and Honeypot holds a bait message only while it waits to act. Incoming events clear out of Proton’s queue within about a day, or about a week if they fail to process.',
  },
];

function Stored(): ReactElement {
  return (
    <section className="landing-section landing-split" aria-labelledby="landing-stored">
      <div className="landing-feature-copy">
        <h2 className="landing-heading" id="landing-stored">
          Message content is only kept if you turn it on
        </h2>
        <div className="landing-stored-links">
          <Link to="/privacy" className="landing-link">
            What Proton stores
            <Icon name="caret-right" size={13} weight="fill" />
          </Link>
          <Link to="/faq" className="landing-link">
            Common questions
            <Icon name="caret-right" size={13} weight="fill" />
          </Link>
        </div>
      </div>

      <ul className="landing-stored">
        {STORED.map((item) => (
          <li key={item.title}>
            <span className="landing-stored-title">{item.title}</span>
            <span className="landing-stored-body">{item.body}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Landing(): ReactElement {
  const signedIn = useSignedIn();
  // State, not the flag: re-reading it on a later render would cut the entrance off mid-flight.
  const [enter] = useState(() => !heroEntered);
  const [live, setLive] = useState(false);
  const shot = useRef<HTMLElement>(null);

  useEffect(() => {
    heroEntered = true;

    const target = shot.current?.querySelector('.landing-window-main .landing-messages');
    if (!enter || !target) return;

    const rect = target.getBoundingClientRect();
    const shown = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    if (shown / rect.height >= 0.6 || typeof IntersectionObserver === 'undefined') {
      setLive(true);
      return;
    }

    // The ratio, not isIntersecting: the first callback reports any overlap, which would start the
    // sequence while most of the messages are still below the fold.
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.intersectionRatio >= 0.6)) return;
        setLive(true);
        observer.disconnect();
      },
      { threshold: 0.6 },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [enter]);

  return (
    <SitePage>
      <div className={cx('landing', enter && 'landing-enter', live && 'landing-live')}>
        <noscript>
          <style>
            {
              '.landing-enter:not(.landing-live) .landing-window-main::before, .landing-enter:not(.landing-live) .landing-shot .landing-msg, .landing-enter:not(.landing-live) .landing-shot .landing-msg-proton::before { animation-play-state: running; } .landing-story-rail { position: static; } .landing-story-title { color: var(--text-primary); } .landing-story-detail { grid-template-rows: 1fr; opacity: 1; }'
            }
          </style>
        </noscript>
        <section className="landing-hero">
          <h1 className="landing-title">One bot for the whole server.</h1>
          <p className="landing-lede">
            Moderation, security and community tools in {MODULES.length} modules, set up from one
            dashboard. Nothing runs until you turn it on.
          </p>
          <Actions signedIn={signedIn} />
          <Link to="/commands" className="landing-link landing-hero-link">
            Browse {COMMAND_SET.length} commands
            <Icon name="caret-right" size={13} weight="fill" />
          </Link>
          <HeroShot figureRef={shot} />
        </section>

        <Story signedIn={signedIn} />
        <Everything />
        <Stored />

        <section className="landing-section landing-close" aria-labelledby="landing-close">
          <div className="landing-close-card">
            <div>
              <h2 className="landing-heading" id="landing-close">
                Add Proton to your server
              </h2>
              <p className="landing-sub">
                Invite it, open the dashboard and turn on what you need.
              </p>
            </div>
            <Actions signedIn={signedIn} />
          </div>
        </section>
      </div>
    </SitePage>
  );
}
