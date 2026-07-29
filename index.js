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

// Temporary storage for media uploads
const pendingMedia = new Map();

// ========== REGISTER SLASH COMMAND ==========
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

// ========== HANDLE INTERACTIONS ==========
client.on(Events.InteractionCreate, async (interaction) => {

  // /post-button command
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

  // Button clicked → show simplified form
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
The player only wrote a free-form description. 
Turn it into a clean bug report.

Reply ONLY with valid JSON in this exact format:

{
  "type": "Crash" or "Bug",
  "subcategory": "UI/Visual" or "AI" or "Gameplay" or null,
  "priority": 1 or 2 or 3 or 4,
  "cleanTitle": "short clear title under 80 characters",
  "summary": "Clean markdown description. Include: What happened, possible steps to reproduce if you can guess them, and platform."
}

Rules:
- type = "Crash" if the game froze, closed, or showed an error
- Otherwise type = "Bug"
- subcategory only when type is Bug
- priority 1 = severe crash / softlock
- priority 2 = important gameplay issue
- priority 3 = normal bug
- priority 4 = minor visual issue

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
        cleanTitle: description.slice(0, 70),
        summary: `**Reporter:** ${reporter}\n\n**Description:**\n${description}\n\n**Platform:** ${platform}`
      };
    }

    // ===== CREATE ISSUE IN LINEAR =====
    try {
      const labelMap = {
        'AI': '350d1237-1fd2-4cdf-8261-99bc677536ea',
        'Bug': '853c01a9-78a2-44f8-a676-e21d8a6ab11b',
        'Crash': '5ff9619b-e2ff-497e-9e3d-c4b194f1d29a',
        'Gameplay': '28dc65d1-2ada-4388-9a62-ce53ba7c6968',
        'UI/Visual': '1b410362-2d0d-4015-b72a-c5e7e7143ac5'
      };

      const labelIds = [];
      if (analysis.type === 'Crash') {
        labelIds.push(labelMap['Crash']);
      } else {
        labelIds.push(labelMap['Bug']);
        if (analysis.subcategory && labelMap[analysis.subcategory]) {
          labelIds.push(labelMap[analysis.subcategory]);
        }
      }

      const mutation = `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              id
              title
              url
            }
          }
        }
      `;

      const variables = {
        input: {
          teamId: process.env.LINEAR_TEAM_ID,
          title: analysis.cleanTitle,
          description: analysis.summary,
          priority: analysis.priority,
          labelIds: labelIds
        }
      };

      const linearRes = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          'Authorization': process.env.LINEAR_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: mutation, variables })
      });

      const linearData = await linearRes.json();

      if (linearData.errors) {
        throw new Error(JSON.stringify(linearData.errors));
      }

      const issueId = linearData.data.issueCreate.issue.id;

      // Create private thread for media
      const thread = await interaction.channel.threads.create({
        name: `media-${interaction.user.username}`.slice(0, 90),
        autoArchiveDuration: 60,
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: 'Bug report media upload'
      });

      // Add the user to the private thread
      await thread.members.add(interaction.user.id);

      // Ask for media
      await thread.send({
        content: `${interaction.user} Please upload any screenshots or videos here.\nYou have **5 minutes**.`
      });

      // Store for later
      pendingMedia.set(thread.id, {
        issueId: issueId,
        originalSummary: analysis.summary,
        timeout: setTimeout(() => {
          pendingMedia.delete(thread.id);
          thread.setArchived(true).catch(() => {});
        }, 5 * 60 * 1000)
      });

      // Thank the user
      await interaction.editReply({
        content: '✅ Thanks for the report! If you have screenshots or videos, please upload them in the private thread I just created.'
      });

    } catch (err) {
      console.error('Linear error:', err);
      await interaction.editReply({
        content: '⚠️ Something went wrong while saving your report. Please try again later.'
      });
    }
  }
});

// ========== MEDIA UPLOAD LISTENER ==========
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;

  const pending = pendingMedia.get(message.channel.id);
  if (!pending) return;

  if (message.attachments.size === 0) return;

  const mediaLinks = [];
  message.attachments.forEach(att => {
    mediaLinks.push(`- [${att.name}](${att.url})`);
  });

  const newDescription = `${pending.originalSummary}

---
**Media Attachments:**
${mediaLinks.join('\n')}`;

  try {
    const updateMutation = `
      mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
        }
      }
    `;

    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Authorization': process.env.LINEAR_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: updateMutation,
        variables: {
          id: pending.issueId,
          input: {
            description: newDescription
          }
        }
      })
    });

    const data = await res.json();

    if (data.errors) {
      throw new Error(JSON.stringify(data.errors));
    }

    await message.reply('✅ Media successfully added to your report. Thank you!');

    clearTimeout(pending.timeout);
    pendingMedia.delete(message.channel.id);
    await message.channel.setArchived(true);

  } catch (err) {
    console.error('Failed to update Linear with media:', err);
    await message.reply('⚠️ Sorry, I could not attach the media to the report.');
  }
});

client.login(process.env.DISCORD_TOKEN);