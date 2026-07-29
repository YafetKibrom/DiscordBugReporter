require('dotenv').config();
const {
  Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, Events, REST, Routes, SlashCommandBuilder
} = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

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
        Routes.applicationGuildCommands(client.user.id, '1397328029356658818'), // Discord ID
        { body: commands }
    );
    console.log('Slash command /post-button registered');
  } catch (error) {
    console.error(error);
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

  // Button clicked → show form
  if (interaction.isButton() && interaction.customId === 'report_bug') {
    const modal = new ModalBuilder()
        .setCustomId('bug_modal')
        .setTitle('Report a Bug / Crash');

    const titleInput = new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Short title of the issue')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

    const whatHappened = new TextInputBuilder()
        .setCustomId('what')
        .setLabel('What happened?')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1500);

    const steps = new TextInputBuilder()
        .setCustomId('steps')
        .setLabel('Steps to reproduce')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1500);

    const platform = new TextInputBuilder()
        .setCustomId('platform')
        .setLabel('Platform / Version / Device')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

    const media = new TextInputBuilder()
        .setCustomId('media')
        .setLabel('Media / Log links')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

    modal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(whatHappened),
        new ActionRowBuilder().addComponents(steps),
        new ActionRowBuilder().addComponents(platform),
        new ActionRowBuilder().addComponents(media)
    );

    await interaction.showModal(modal);
  }

  // Form submitted
  if (interaction.isModalSubmit() && interaction.customId === 'bug_modal') {
    await interaction.deferReply({ flags: 64 });

    const title = interaction.fields.getTextInputValue('title');
    const what = interaction.fields.getTextInputValue('what');
    const steps = interaction.fields.getTextInputValue('steps');
    const platform = interaction.fields.getTextInputValue('platform') || 'Not specified';
    const media = interaction.fields.getTextInputValue('media') || 'None';
    const reporter = interaction.user.tag;

    // ===== AI ANALYSIS =====
    const aiPrompt = `
You are an expert game bug triage assistant.
Analyze the report and reply ONLY with valid JSON in this exact format:

{
  "type": "Crash" or "Bug",
  "subcategory": "UI/Visual" or "AI" or "Gameplay" or null,
  "priority": 1 or 2 or 3 or 4,   // 1=Urgent, 2=High, 3=Medium, 4=Low
  "cleanTitle": "short clear title",
  "summary": "clean markdown description for developers"
}

Rules:
- If the game freezes, closes, or shows an error → type = "Crash"
- Otherwise type = "Bug"
- subcategory only if type is Bug
- priority 1 for crashes and severe gameplay blockers
- priority 2 for important bugs
- priority 3 for normal bugs
- priority 4 for minor visual issues

Report:
Title: ${title}
Reporter: ${reporter}
What happened: ${what}
Steps: ${steps}
Platform: ${platform}
Media: ${media}
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
          temperature: 0.1
        })
      });

      const aiData = await aiRes.json();
      const raw = aiData.choices[0].message.content;
      // Extract JSON even if the model wraps it
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch[0]);
    } catch (err) {
      console.error('AI error:', err);
      analysis = {
        type: 'Bug',
        subcategory: 'Gameplay',
        priority: 3,
        cleanTitle: title,
        summary: `**Reporter:** ${reporter}\n\n**What happened:**\n${what}\n\n**Steps:**\n${steps}\n\n**Platform:** ${platform}\n\n**Media:**\n${media}`
      };
    }

    // ===== CREATE ISSUE IN LINEAR =====
    try {
      // Map labels (you will replace these with real IDs later)
      const labelMap = {
        'AI' : '350d1237-1fd2-4cdf-8261-99bc677536ea',
        'Bug' : '853c01a9-78a2-44f8-a676-e21d8a6ab11b',
        'Crash' : '5ff9619b-e2ff-497e-9e3d-c4b194f1d29a',
        'Gameplay' : '28dc65d1-2ada-4388-9a62-ce53ba7c6968',
        'UI/Visual' : '1b410362-2d0d-4015-b72a-c5e7e7143ac5'
      };
      
      
      const labelIds = [];
      if (analysis.type === 'Crash') labelIds.push(labelMap['Crash']);
      if (analysis.type === 'Bug') {
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

      const issueUrl = linearData.data.issueCreate.issue.url;

      await interaction.editReply({
        content: `✅ Thank you! Your report has been submitted.\n${issueUrl}`
      });

    } catch (err) {
      console.error('Linear error:', err);
      await interaction.editReply({
        content: '⚠️ Something went wrong while creating the issue in Linear.'
      });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);