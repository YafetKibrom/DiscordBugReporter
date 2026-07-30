require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping
  ]
});

const pendingMedia = new Map();

// ========== CODECKS DECKS ==========
const CRASH_DECK_ID = '157be112-89b8-11f1-b0c5-132bb3e095dd';
const BUGS_DECK_ID  = '6605bb94-8613-11f1-b0b5-2be4b8796f80';

// ========== FALLBACK CHANNEL ==========
const FALLBACK_CHANNEL_ID = '1532428137806434394';

// ========== LINEAR LABELS ==========
const LINEAR_LABELS = {
  'AI': '350d1237-1fd2-4cdf-8261-99bc677536ea',
  'Bug': '853c01a9-78a2-44f8-a676-e21d8a6ab11b',
  'Crash': '5ff9619b-e2ff-497e-9e3d-c4b194f1d29a',
  'Gameplay': '28dc65d1-2ada-4388-9a62-ce53ba7c6968',
  'UI/Visual': '1b410362-2d0d-4015-b72a-c5e7e7143ac5'
};

client.once(Events.ClientReady, async () => {
  console.log(`Bot is online as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('post-button')
      .setDescription('Post the bug report button in this channel')
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, '1397328029356658818'),
      { body: commands }
    );
    console.log('Slash command /post-button registered');
  } catch (error) {
    console.error('Failed to register slash command:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // /post-button
    if (interaction.isChatInputCommand() && interaction.commandName === 'post-button') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('report_bug')
          .setLabel('Report a Bug / Crash')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🐛')
      );

      await interaction.reply({
        content: 'Found a bug or crash? Click the button below to report it!',
        components: [row]
      });
      return;
    }

    // Button → Modal
    if (interaction.isButton() && interaction.customId === 'report_bug') {
      const modal = new ModalBuilder()
        .setCustomId('bug_modal')
        .setTitle('Report a Bug / Crash');

      const descriptionInput = new TextInputBuilder()
        .setCustomId('description')
        .setLabel('What happened?')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('Describe the bug or crash in your own words...')
        .setMaxLength(1800);

      const platformInput = new TextInputBuilder()
        .setCustomId('platform')
        .setLabel('Platform / Version (optional)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder('e.g. Steam, Windows, v1.0.3');

      modal.addComponents(
        new ActionRowBuilder().addComponents(descriptionInput),
        new ActionRowBuilder().addComponents(platformInput)
      );

      await interaction.showModal(modal);
      return;
    }

    // Form submitted
    if (interaction.isModalSubmit() && interaction.customId === 'bug_modal') {
      await interaction.deferReply({ flags: 64 });

      const description = interaction.fields.getTextInputValue('description');
      const platform = interaction.fields.getTextInputValue('platform') || 'Not specified';
      const reporter = interaction.user.tag;

      // ===== AI ANALYSIS =====
      const aiPrompt = `
You are an expert game bug triage assistant.
Analyze the player's report and reply ONLY with valid JSON:

{
  "type": "Crash" or "Bug",
  "subcategory": "UI/Visual" or "AI" or "Gameplay" or null,
  "priority": 1 or 2 or 3 or 4,
  "cleanTitle": "task-style title starting with Fix, Investigate, or Resolve",
  "summary": "Clean markdown description for developers"
}

Rules for cleanTitle:
- Must sound like a task (e.g. "Fix Melee Lock")

Rules for type:
- "Crash" if the game froze, closed, softlocked, or stops progress
- "Bug" otherwise

Rules for priority:
- 1 = Urgent (crashes / softlocks)
- 2 = High
- 3 = Medium
- 4 = Low (pure visual)

Player report:
"${description}"

Platform: ${platform}
Reporter: ${reporter}
`;

      let analysis;
      try {
        const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: aiPrompt }],
            temperature: 0.15
          })
        });

        const aiData = await aiRes.json();
        const raw = aiData.choices[0].message.content;
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        analysis = JSON.parse(jsonMatch[0]);
      } catch (err) {
        console.error('AI error:', err);
        analysis = {
          type: 'Bug',
          subcategory: 'Gameplay',
          priority: 3,
          cleanTitle: `Fix ${description.slice(0, 50)}`,
          summary: `**Reporter:** ${reporter}\n\n**Description:**\n${description}\n\n**Platform:** ${platform}`
        };
      }

      // ===== LINEAR: SEARCH FOR DUPLICATES =====
      let existingLinearIssue = null;

      try {
        const searchQuery = `
          query {
            issues(
              filter: {
                team: { id: { eq: "${process.env.LINEAR_TEAM_ID}" } }
                state: { type: { nin: ["completed", "canceled"] } }
              }
              first: 40
            ) {
              nodes {
                id
                title
                description
                url
              }
            }
          }
        `;

        const searchRes = await fetch('https://api.linear.app/graphql', {
          method: 'POST',
          headers: {
            'Authorization': process.env.LINEAR_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ query: searchQuery })
        });

        const searchData = await searchRes.json();
        const openIssues = searchData.data?.issues?.nodes || [];

        if (openIssues.length > 0) {
          const issuesList = openIssues.map((issue, i) =>
            `${i + 1}. ID: ${issue.id}\nTitle: ${issue.title}\nDescription: ${(issue.description || '').slice(0, 250)}`
          ).join('\n\n');

          const duplicatePrompt = `
You are a bug triage expert.

NEW report:
Title: ${analysis.cleanTitle}
Summary: ${analysis.summary}

Open issues:
${issuesList}

Does the NEW report describe the same underlying bug as any existing issue?
Focus on the core problem, not exact wording.

Reply ONLY with JSON:
{
  "isDuplicate": true or false,
  "matchingIssueId": "id or null",
  "reason": "short explanation"
}
`;

          const dupRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              messages: [{ role: 'user', content: duplicatePrompt }],
              temperature: 0.1
            })
          });

          const dupData = await dupRes.json();
          const dupRaw = dupData.choices[0].message.content;
          const dupJson = JSON.parse(dupRaw.match(/\{[\s\S]*\}/)[0]);

          if (dupJson.isDuplicate && dupJson.matchingIssueId) {
            existingLinearIssue = openIssues.find(i => i.id === dupJson.matchingIssueId);
            console.log('Duplicate detected:', dupJson.reason);
          }
        }
      } catch (err) {
        console.error('Duplicate check error:', err);
      }

      // ===== CREATE OR UPDATE LINEAR ISSUE =====
      let linearIssueId = null;
      let linearIssueUrl = null;
      let isUpdate = false;

      try {
        const labelIds = [];
        if (analysis.type === 'Crash') {
          labelIds.push(LINEAR_LABELS['Crash']);
        } else {
          labelIds.push(LINEAR_LABELS['Bug']);
          if (analysis.subcategory && LINEAR_LABELS[analysis.subcategory]) {
            labelIds.push(LINEAR_LABELS[analysis.subcategory]);
          }
        }

        if (existingLinearIssue) {
          // Update existing Linear issue
          isUpdate = true;
          linearIssueId = existingLinearIssue.id;
          linearIssueUrl = existingLinearIssue.url;

          const updatedDescription = `${existingLinearIssue.description || ''}

---
**Additional report by ${reporter}:**
${analysis.summary}
`;

          await fetch('https://api.linear.app/graphql', {
            method: 'POST',
            headers: {
              'Authorization': process.env.LINEAR_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              query: `
                mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
                  issueUpdate(id: $id, input: $input) { success }
                }
              `,
              variables: {
                id: linearIssueId,
                input: { description: updatedDescription }
              }
            })
          });

        } else {
          // Create new Linear issue
          const createRes = await fetch('https://api.linear.app/graphql', {
            method: 'POST',
            headers: {
              'Authorization': process.env.LINEAR_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              query: `
                mutation IssueCreate($input: IssueCreateInput!) {
                  issueCreate(input: $input) {
                    success
                    issue { id title url }
                  }
                }
              `,
              variables: {
                input: {
                  teamId: process.env.LINEAR_TEAM_ID,
                  title: analysis.cleanTitle,
                  description: analysis.summary,
                  priority: analysis.priority,
                  labelIds: labelIds
                }
              }
            })
          });

          const createData = await createRes.json();
          if (createData.errors) throw new Error(JSON.stringify(createData.errors));

          linearIssueId = createData.data.issueCreate.issue.id;
          linearIssueUrl = createData.data.issueCreate.issue.url;
        }

        // ===== CREATE CODECKS CARD (only for new issues) =====
        if (!isUpdate) {
          const deckId = analysis.type === 'Crash' ? CRASH_DECK_ID : BUGS_DECK_ID;

          const codecksContent = `**${analysis.cleanTitle}**

${analysis.summary}

---
🔗 **Linear Issue:** ${linearIssueUrl}
`;

          const codecksRes = await fetch('https://api.codecks.io/dispatch/cards/create', {
            method: 'POST',
            headers: {
              'X-Auth-Token': process.env.CODECKS_TOKEN,
              'X-Account': process.env.CODECKS_SUBDOMAIN,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              assigneeId: null,
              content: codecksContent,
              deckId: deckId,
              milestoneId: null,
              masterTags: [],
              attachments: [],
              effort: 3,
              priority: analysis.priority <= 2 ? 'a' : (analysis.priority === 3 ? 'b' : 'c')
            })
          });

          if (!codecksRes.ok) {
            const errText = await codecksRes.text();
            console.error('Codecks create failed:', errText);
          }
        }

        // ===== MEDIA THREAD =====
        const thread = await interaction.channel.threads.create({
          name: `media-${interaction.user.username}`.slice(0, 90),
          autoArchiveDuration: 60,
          type: ChannelType.PrivateThread,
          invitable: false,
          reason: 'Bug report media upload'
        });

        await thread.members.add(interaction.user.id);
        await thread.send(`${interaction.user} Please upload any screenshots or videos here.\nYou have **5 minutes**.`);

        pendingMedia.set(thread.id, {
          linearIssueId: linearIssueId,
          timeout: setTimeout(() => {
            pendingMedia.delete(thread.id);
            thread.setArchived(true).catch(() => {});
          }, 5 * 60 * 1000)
        });

        const replyText = isUpdate
          ? '✅ Thanks! This looks related to an existing report — your extra info has been added.'
          : '✅ Thanks for the report! If you have screenshots or videos, please upload them in the private thread.';

        await interaction.editReply({ content: replyText });

      } catch (err) {
        console.error('Main processing error:', err);

        // Fallback
        try {
          const fallbackChannel = await client.channels.fetch(FALLBACK_CHANNEL_ID);
          if (fallbackChannel) {
            await fallbackChannel.send({
              content: `🚨 **Failed to process report**\n\n**Reporter:** ${reporter}\n**Platform:** ${platform}\n\n**Report:**\n${description}\n\n**Error:**\n\`\`\`${err.message || err}\`\`\``
            });
          }
        } catch (e) {
          console.error('Fallback failed:', e);
        }

        await interaction.editReply({
          content: '✅ Thanks! We received your report. The team will look into it.'
        });
      }
    }
  } catch (err) {
    console.error('Unhandled interaction error:', err);
  }
});

// ===== MEDIA UPLOAD → add to Linear =====
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;

  const pending = pendingMedia.get(message.channel.id);
  if (!pending || !pending.linearIssueId) return;
  if (message.attachments.size === 0) return;

  const mediaLinks = [];
  message.attachments.forEach(att => {
    mediaLinks.push(`- [${att.name}](${att.url})`);
  });

  try {
    // Get current description
    const getRes = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Authorization': process.env.LINEAR_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: `query { issue(id: "${pending.linearIssueId}") { description } }`
      })
    });

    const getData = await getRes.json();
    const currentDesc = getData.data?.issue?.description || '';

    const newDesc = `${currentDesc}

---
**Media:**
${mediaLinks.join('\n')}`;

    await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Authorization': process.env.LINEAR_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: `
          mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success }
          }
        `,
        variables: {
          id: pending.linearIssueId,
          input: { description: newDesc }
        }
      })
    });

    await message.reply('✅ Media added to the report. Thank you!');
    clearTimeout(pending.timeout);
    pendingMedia.delete(message.channel.id);
    await message.channel.setArchived(true);

  } catch (err) {
    console.error('Media update error:', err);
    await message.reply('⚠️ Could not attach the media automatically.');
  }
});

client.login(process.env.DISCORD_TOKEN);
