import Stash from './stash/stash.js';
import config from './config.json';
import prompt from 'prompt';
import * as messages from './messages.js';
import * as teamcity from './teamcity/teamcity.js';
import * as deployments from './deploy/deploy.js';
import {
  checkFoodMessages
}
from './food.js';
import {
  humorMessages,
  startPledge
}
from './humor.js';

const stashClient = new Stash({
  root: config.stashRoot,
  projectName: config.stashProject,
  repo: config.stashRepo
});

let quietMode = false;
if(process.argv && process.argv.length) {
  process.argv.forEach((val,index,arr) => {
    if(val === '--no-respond') {
      quietMode = true;
      console.log('Quiet mode engaged!');
    }
  });
}

var RtmClient = require('slack-client/lib/clients/rtm/client');
var RTM_EVENTS = require('slack-client/lib/clients/events/rtm').EVENTS;
var RTM_CLIENT_EVENTS = require('@slack/client').CLIENT_EVENTS.RTM;
var request = require('request');

var token = process.env.SLACK_API_TOKEN || config.slackToken;

var rtm = new RtmClient(token, {
  logLevel: 'debug'
});
rtm.start();

prompt.start();
function promptLoop() {
  prompt.get(['message'], function (err, result) {
    if(err) { console.log('ERROR ==================================', err.message)}
    console.log('Sending', result.message);
    sendTeamMessage(result.message);
    promptLoop();
  });
}
promptLoop();


rtm.on(RTM_EVENTS.MESSAGE, function handleRtmMessage(message) {
  if(!quietMode) {
    if(/(start standup|start scrum)/i.test(message.text)) {
      startPledge(rtm);
      return;
    }
    console.log('Message:', message);
    checkFoodMessages(message, rtm);
    humorMessages(message, rtm);
    deployments.checkDeploymentMessages(message, rtm);
    console.log('Checking for the any prs notification');
    if (/(any prs|any pull requests|any pr's|have prs|have pr's)/i.test(message.text)) {
      console.log('Found any prs notification');
      checkPullRequests(true); // DO IT NAOW!
    }
  } else {
    console.log('Quiet mode, not responding to messages...');
  }
});

rtm.on(RTM_EVENTS.REACTION_ADDED, function handleRtmReactionAdded(reaction) {
  console.log('Reaction added:', reaction);
});

rtm.on(RTM_EVENTS.REACTION_REMOVED, function handleRtmReactionRemoved(reaction) {
  console.log('Reaction removed:', reaction);
});

function sendTeamMessage(message) {
  rtm.sendMessage(message, config.room, () => console.log('Sent', message));
  console.log('Sending', message);
}

function stashReminderLoop() {
  setTimeout(() => {
    if ((new Date().getHours() + 1) >= config.startHour && (new Date().getHours() + 1) < config.endHour) {
      checkPullRequests();
    }
    else {
      console.log('prrrr taco cat PR check is sleeping');
    }
    stashReminderLoop();
  }, config.pullRequestNotificationDelay || (60 * 60 * 1000));
}



var isFirstTeamCityCheck = true;
function checkTeamCityLoop() {
  setTimeout(() => {
    teamcity.getNewFailedBuilds((builds) => {
      //cache all the current build failures (no need to report on those right away)
      if(isFirstTeamCityCheck) {
        isFirstTeamCityCheck = false;
        checkTeamCityLoop();
      } else {
        if(builds.length > 0) {
          //get the build details for each failure
          var waitingOn = builds.length;
          var buildDetails = [];
          for(var i = 0; i < builds.length; i++) {
            teamcity.getBuildDetail(builds[i].id, (build) => {
              buildDetails.push(build);
              waitingOn--;

              if(waitingOn <= 0) {
                //We're done
                let buildString = '';
                buildDetails.forEach((bd) => {
                  let changes = '';
                  bd.lastChanges.change.forEach((change) => {
                    changes = changes ? ` and ${change.username}` : change.username;
                  });
                  buildString += `${bd.buildType.name} triggered by ${bd.triggered.details} last changes from ${changes}\r\n`;
                });
                sendTeamMessage('Oh, man, you guys totally FAILED some builds\r\n' + buildString);
                console.log(buildString);
                // console.log(buildDetails[0].buildType.name,'triggered by', buildDetails[0].triggered.details,'last changes from',buildDetails[0].lastChanges.change[0].username);

                checkTeamCityLoop();
              }
            });
          }
        }
      }

    });
  }, config.checkTeamCityDelay || (60 * 5 * 1000));
}

function checkProductionLoop() {
  setTimeout(() => {
    checkProductionLinks();
  }, config.checkProductionDelay || (60 * 5 * 1000));
}

function checkProductionLinks() {
  try {
    request(config.productionLink, function(error, response, body) {
      if (error) {
        sendTeamMessage("<!channel> Okay, who broke production? It's telling me " + error.message);
        console.log(error);
        return;
      }

      if (response) {
        if(response.statusCode !== 200) {
          sendTeamMessage("<!channel> What is this crap? I called production and it gave me " + response.statusCode + " for a return code!");
        }
        console.log('response');
        console.log(response);
        return;
      } else {
        sendTeamMessage("<!channel> Uh, hello? Knock knock? Production's response to me was falsey.");
        return;
      }

      if (!body) {
        sendTeamMessage("<!channel> Anybody home? In production's response to me the body was falsey. What is this crap?");
        return;
      }

      console.log('All seems to be well with prod, yo');
    });
  }
  catch (e) {
    sendTeamMessage("<!channel> Production must be having a bad day. I tried to bring it up and it said " + e.message);
  }
}

function checkPullRequests(userPrompted) {
  try {
    stashClient.getPullRequests((err, resp) => {
      console.log('Got response for checkPullRequests');
      if (resp === undefined) {
        sendTeamMessage("Stash has lost it. I asked it for pull requests, it said 'undefined'.");
        return;
      }
      if (err) {
        sendTeamMessage("Guys ... is Stash down or something? I asked it for pull requests, it gave me an error! " + err);
      }
      const openPullRequests = resp.values.filter((pr) => pr.open);

      if (openPullRequests.length > 0) {
        var message = messages.pr_messages(openPullRequests, rtm);
      } else if(userPrompted) {
        messages.pr_messages([], rtm);
      }
    });
  }
  catch (e) {
    console.log('An error happened with checkPullRequests');
    sendTeamMessage("Stash must be having a bad day. I asked it for pull requests. It said " + e.message);
  }
}

// you need to wait for the client to fully connect before you can send messages
rtm.on(RTM_CLIENT_EVENTS.RTM_CONNECTION_OPENED, function() {
  // This will send the message 'this is a test message' to the channel identified by id 'C0CHZA86Q'
  // rtm.sendMessage('So when is lunch?', 'C03KL4SUN', function messageSent() {
  //   // optionally, you can supply a callback to execute once the message has been sent
  //   console.log('message sent');
  // });

  stashReminderLoop();
  checkProductionLoop();
  checkTeamCityLoop();
  // get pull requests
});
