import { createFileRoute, Link } from '@tanstack/react-router';
import { type ReactElement, type ReactNode, type Ref, useEffect, useRef, useState } from 'react';
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
  ChatLink,
  ChatMessage,
  ChatRow,
  ChatSeparator,
  ChatText,
  ChatTime,
  ChatWindow,
  Composer,
  Mention,
  ServerRail,
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
                Welcome to <strong>Northwind</strong>, <Mention>@kai</Mention>. Grab your roles in{' '}
                <Mention>#roles</Mention>.
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
              { name: 'Messages deleted', value: 'the last day', inline: true },
              { name: 'Result', value: 'Done', inline: true },
            ]}
            footer="Today at 9:43 PM"
          />
        </ChatMessage>
        <ChatMessage proton continued>
          <ChatText>
            <strong>Raid mode.</strong> 14 accounts joined within 10s, at or above this server's
            threshold of 10. Joins scoring 4/5 or higher are being given the verification role.
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
          Anti-nuke tripped: 6 channel deletions within 10s by 1150384920117248 (limit 5 per 10s).
          {'\n'}
          Removed 3 of their 3 roles first: <Mention>@Admin</Mention>, <Mention>@Moderator</Mention>
          , <Mention>@Helper</Mention>. Every removal is recorded as a Proton case carrying the full
          set, so their roles can be restored exactly.{'\n'}
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
          Message: <ChatLink>https://discord.com/channels/1204/5531/8812</ChatLink> — still up;
          delete it manually.{'\n'}
          Action: timed out for 1d. If this was wrong, add <ChatCode>gift.example</ChatCode> to
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
      >
        <ChatText>
          Warned <Mention>@kai</Mention>.
        </ChatText>
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

function CommunityShot(): ReactElement {
  return (
    <ChatWindow channel="giveaways" className="landing-window-card">
      <ChatMessage proton time="Today at 12:00 PM">
        <ChatContainer accent="#5865f2">
          <ChatHeading level={1}>🎉 Custom role colour</ChatHeading>
          <ChatSeparator />
          <ChatText>
            🏆 <strong>Winners</strong>
            {'\n'}2{'\n\n'}⏰ <strong>Ends</strong>
            {'\n'}
            <ChatTime>in 2 days</ChatTime>
            {'\n\n'}🎫 <strong>Entries</strong>
            {'\n'}148{'\n\n'}👤 <strong>Hosted by</strong>
            {'\n'}
            <Mention>@mira</Mention>
          </ChatText>
          <ChatSeparator />
          <ChatRow>
            <ChatButton emoji="🎉">Enter giveaway</ChatButton>
            <ChatButton tone="secondary" emoji="🚪">
              Leave
            </ChatButton>
          </ChatRow>
        </ChatContainer>
      </ChatMessage>
    </ChatWindow>
  );
}

const FEATURES: readonly {
  id: string;
  title: string;
  lede: string;
  modules: readonly string[];
  shot: () => ReactNode;
}[] = [
  {
    id: 'security',
    title: 'Acts on spam, raids and nukes as they happen',
    lede: 'Automod filters spam, Anti-Raid scores every join, Anti-Nuke strips roles from members making destructive changes too quickly, and Honeypot catches spam bots and hacked accounts that post in bait channels.',
    modules: ['automod', 'antiraid', 'antinuke', 'phishing', 'honeypot'],
    shot: SecurityShot,
  },
  {
    id: 'moderation',
    title: 'Every action on the record',
    lede: 'Warnings, timeouts, kicks and bans each become a numbered case. Repeat warnings climb a ladder you set, and members appeal through a form instead of a DM.',
    modules: ['moderation', 'cases', 'appeals', 'permissions'],
    shot: ModerationShot,
  },
  {
    id: 'community',
    title: 'Something for members to use',
    lede: 'Tickets, role menus, levels, giveaways, polls, suggestions, a starboard, and voice channels members create for themselves.',
    modules: [
      'tickets',
      'rolemenu',
      'leveling',
      'giveaways',
      'polls',
      'suggestions',
      'starboard',
      'tempvc',
    ],
    shot: CommunityShot,
  },
];

function Features(): ReactElement {
  return (
    <section className="landing-section landing-features" aria-label="What Proton does">
      {FEATURES.map((feature, index) => (
        <div className={cx('landing-feature', index % 2 === 1 && 'flip')} key={feature.id}>
          <div className="landing-feature-copy">
            <h2 className="landing-heading">{feature.title}</h2>
            <p className="landing-sub">{feature.lede}</p>
            <ul className="landing-modules">
              {feature.modules.map((moduleId) => {
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
          </div>
          <figure className="landing-feature-figure">
            <feature.shot />
            <figcaption className="landing-caption">Illustrative example.</figcaption>
          </figure>
        </div>
      ))}
    </section>
  );
}

function Everything(): ReactElement {
  return (
    <section className="landing-section" aria-labelledby="modules">
      <h2 className="landing-heading landing-modules-heading" id="modules">
        All {MODULES.length} modules in one bot
      </h2>
      <p className="landing-sub">Each one starts off. Switch on what your server needs.</p>

      <div className="landing-index">
        {NAV_GROUPS.map((group) => {
          const members = MODULES.filter((meta) => meta.group === group.id);
          if (members.length === 0) return null;

          return (
            <div className="landing-index-group" key={group.id}>
              <h3 className="landing-index-label">{group.label}</h3>
              <ul>
                {members.map((meta) => (
                  <li className="landing-index-item" key={meta.id}>
                    <Icon name={meta.icon} size={16} className="landing-index-icon" />
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
    </section>
  );
}

function Dashboard({ signedIn }: { signedIn: boolean | null }): ReactElement {
  return (
    <section className="landing-section landing-split" aria-labelledby="landing-dashboard">
      <div className="landing-feature-copy">
        <h2 className="landing-heading" id="landing-dashboard">
          Set it all up in one dashboard
        </h2>
        <p className="landing-sub">
          Every module is set up in the same dashboard, with one save bar and one case log. When
          Proton can’t act, the page names the missing permission or intent.
        </p>
        <Link to={signedIn === true ? '/dashboard' : '/signin'} className="landing-link">
          Open the dashboard
          <Icon name="caret-right" size={13} weight="fill" />
        </Link>
      </div>

      <figure className="landing-dash-figure">
        <DashboardShot />
        <figcaption className="landing-caption">Illustrative settings.</figcaption>
      </figure>
    </section>
  );
}

const STORED: readonly { title: string; body: string }[] = [
  {
    title: 'Logging is opt-in',
    body: 'Message logging and ticket transcripts stay off until you switch them on.',
  },
  {
    title: 'Deleted after 30 days',
    body: 'Stored message content is deleted after 30 days.',
  },
  {
    title: 'Reading isn’t storing',
    body: 'Automod, the phishing filter and Honeypot read messages to decide whether to act. Reading a message doesn’t store it.',
  },
];

function Stored(): ReactElement {
  return (
    <section className="landing-section landing-split" aria-labelledby="landing-stored">
      <div className="landing-feature-copy">
        <h2 className="landing-heading" id="landing-stored">
          Message content is only kept if you switch it on
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
              '.landing-enter:not(.landing-live) .landing-window-main::before, .landing-enter:not(.landing-live) .landing-shot .landing-msg, .landing-enter:not(.landing-live) .landing-shot .landing-msg-proton::before { animation-play-state: running; }'
            }
          </style>
        </noscript>
        <section className="landing-hero">
          <h1 className="landing-title">One bot for the whole server.</h1>
          <p className="landing-lede">
            Moderation, security and community tools in {MODULES.length} modules, set up from one
            dashboard. Nothing runs until you switch it on.
          </p>
          <Actions signedIn={signedIn} />
          <Link to="/commands" className="landing-link landing-hero-link">
            Browse {COMMAND_SET.length} commands
            <Icon name="caret-right" size={13} weight="fill" />
          </Link>
          <HeroShot figureRef={shot} />
        </section>

        <Features />
        <Everything />
        <Dashboard signedIn={signedIn} />
        <Stored />

        <section className="landing-close" aria-labelledby="landing-close">
          <h2 className="landing-heading" id="landing-close">
            Add Proton to your server
          </h2>
          <p className="landing-sub">Invite it, open the dashboard and switch on what you need.</p>
          <Actions signedIn={signedIn} />
        </section>
      </div>
    </SitePage>
  );
}
