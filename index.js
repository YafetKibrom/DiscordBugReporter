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

// ========== DECK IDS ==========
const CRASH_DECK_ID = '157be112-89b8-11f1-b0c5-132bb3e095dd';
const BUGS_DECK_ID  = '35187e06-8b46-11f1-b0c9-c39d28479dde';

// ========== FALLBACK CHANNEL ==========
const FALLBACK_CHANNEL_ID = '1532428137806434394';

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
Analyze the player's report and reply ONLY with valid JSON in this exact format:

{
  "type": "Crash" or "Bug",
  "priority": "a" or "b" or "c",
  "effort": 1 to 8,
  "cleanTitle": "short clear title under 80 characters",
  "summary": "Clean markdown description for developers"
}

Rules for type:
- "Crash" if the game froze, closed, softlocked, or showed an error that stops progress
- "Bug" for everything else

Rules for priority:
- "a" (High) = Crashes or any issue that prevents the player from continuing the game
- "c" (Low) = Pure UI or visual issues that do not affect gameplay
- "b" (Medium) = Everything in between

Rules for effort (difficulty):
- 1-2 = Very simple (typo, small visual, easy fix)
- 3-4 = Moderate
- 5-6 = Complex
- 7-8 = Very difficult / deep systems

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
        priority: 'b',
        effort: 4,
        cleanTitle: description.slice(0, 70),
        summary: `**Reporter:** ${reporter}\n\n**Description:**\n${description}\n\n**Platform:** ${platform}`
      };
    }

    // ===== CREATE CARD IN CODECKS =====
    try {
      const deckId = analysis.type === 'Crash' ? CRASH_DECK_ID : BUGS_DECK_ID;

      const cardRes = await fetch('https://api.codecks.io/dispatch/cards/create', {
        method: 'POST',
        headers: {
          'X-Auth-Token': process.env.CODECKS_TOKEN,
          'X-Account': process.env.CODECKS_SUBDOMAIN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: `**${analysis.cleanTitle}**\n\n${analysis.summary}`,
          deckId: deckId,
          priority: analysis.priority,
          effort: analysis.effort,
          assigneeId: null,
          milestoneId: null,
          masterTags: [],
          attachments: []
        })
      });

      if (!cardRes.ok) {
        const errText = await cardRes.text();
        throw new Error(errText);
      }

      const cardData = await cardRes.json();
      const cardId = cardData.id || cardData.cardId || null;

      // ===== CREATE PRIVATE THREAD FOR MEDIA =====
      const thread = await interaction.channel.threads.create({
        name: `media-${interaction.user.username}`.slice(0, 90),
        autoArchiveDuration: 60,
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: 'Bug report media upload'
      });

      await thread.members.add(interaction.user.id);

      await thread.send({
        content: `${interaction.user} Please upload any screenshots or videos here.\nYou have **5 minutes**.`
      });

      pendingMedia.set(thread.id, {
        cardId: cardId,
        originalSummary: analysis.summary,
        timeout: setTimeout(() => {
          pendingMedia.delete(thread.id);
          thread.setArchived(true).catch(() => {});
        }, 5 * 60 * 1000)
      });

      await interaction.editReply({
        content: '✅ Thanks for the report! If you have screenshots or videos, please upload them in the private thread I just created.'
      });

    } catch (err) {
      console.error('Codecks error:', err);

      // ===== FALLBACK: Post to staff channel =====
      try {
        const fallbackChannel = await client.channels.fetch(FALLBACK_CHANNEL_ID);

        if (fallbackChannel) {
          await fallbackChannel.send({
            content: `🚨 **Failed to create Codecks card**\n\n**Reporter:** ${reporter}\n**Platform:** ${platform}\n**Type:** ${analysis?.type || 'Unknown'}\n**Priority:** ${analysis?.priority || 'Unknown'}\n\n**Original Report:**\n${description}\n\n**AI Summary:**\n${analysis?.summary || 'N/A'}\n\n**Error:**\n\`\`\`${err.message || err}\`\`\``
          });
        }
      } catch (fallbackErr) {
        console.error('Failed to send fallback message:', fallbackErr);
      }

      // Still tell the player we received it
      await interaction.editReply({
        content: '✅ Thanks! We received your report. The team will look into it.'
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

  try {
    await message.reply('✅ Media received! Thank you, the team will see it.');

    clearTimeout(pending.timeout);
    pendingMedia.delete(message.channel.id);
    await message.channel.setArchived(true);

  } catch (err) {
    console.error('Media handling error:', err);
    await message.reply('⚠️ Something went wrong while processing the media.');
  }
});

client.login(process.env.DISCORD_TOKEN);
