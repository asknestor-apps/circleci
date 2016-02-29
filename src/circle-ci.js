var url = require('url');
var util = require('util');
var querystring = require('querystring');

var circleciHost = process.env.NESTOR_CIRCLECI_HOST ? process.env.NESTOR_CIRCLECI_HOST : "circleci.com";
var endpoint = "https://" + circleciHost + "/api/v1";

var toProject = function(project) {
  if (project.indexOf("/") === -1 && (process.env.NESTOR_GITHUB_ORG !== null)) {
    return process.env.NESTOR_GITHUB_ORG + "/" + project;
  } else {
    return project;
  }
};

var toSha = function(vcs_revision) {
  return vcs_revision.substring(0, 7);
};

var toDisplay = function(status) {
  return status[0].toUpperCase() + status.slice(1);
};

var formatBuildStatus = function(build) {
  return (toDisplay(build.status)) + " in build " + build.build_num + " of " + build.vcs_url + " [" + build.branch + "/" + (toSha(build.vcs_revision)) + "] " + build.committer_name + ": " + build.subject + " - " + build.why;
};

var retryBuild = function(robot, msg, endpoint, project, build_num, done) {
  robot.http(endpoint + "/project/" + project + "/" + build_num + "/retry?circle-token=" + process.env.NESTOR_CIRCLECI_TOKEN).headers({
    "Accept": "application/json"
  }).post('{}')(handleResponse(msg, function(response) {
    msg.send("Retrying build " + build_num + " of " + project + " [" + response.branch + "] with build " + response.build_num , done);
  }));
};

var getProjectsByStatus = function(robot, msg, endpoint, status, action, done) {
  var projects = [];

  robot.http(endpoint + "/projects?circle-token=" + process.env.NESTOR_CIRCLECI_TOKEN).headers({
    "Accept": "application/json"
  }).get()(handleResponse(msg, function(response) {
    var build_branch, i, last_build, len, project;
    for (i = 0, len = response.length; i < len; i++) {
      project = response[i];
      build_branch = project.branches[project.default_branch];
      last_build = build_branch.recent_builds[0];
      if (last_build.outcome === status) {
        projects.push(project);
      }
    }

    if (action === 'list') {
      listProjectsByStatus(msg, projects, status, done);
    }
  }));
};

var listProjectsByStatus = function(msg, projects, status, done) {
  var build_branch, i, last_build, len, project;
  if (projects.length === 0) {
    msg.send("No projects match status " + status, done);
  } else {
    var message = "Projects where the last build's status is " + status + ":\n";
    for (i = 0, len = projects.length; i < len; i++) {
      project = projects[i];
      build_branch = project.branches[project.default_branch];
      last_build = build_branch.recent_builds[0];
      message = message + ((toDisplay(last_build.outcome)) + " in build https://circleci.com/gh/" + project.username + "/" + project.reponame + "/" + last_build.build_num + " of " + project.vcs_url + " [" + project.default_branch + "]\n");
    }
    msg.send(message, done);
  }
};

var clearProjectCache = function(msg, endpoint, project, done) {
  msg.http(endpoint + "/project/" + project + "/build-cache?circle-token=" + process.env.NESTOR_CIRCLECI_TOKEN).headers({
    "Accept": "application/json"
  }).del('{}')(handleResponse(msg, function(response) {
    msg.send("Cleared build cache for " + project, done);
  }));
};

var handleResponse = function(msg, handler, done) {
  return function(err, res, body) {
    var response;
    if (err !== null) {
      msg.send("Something went really wrong: " + err, done);
    }
    switch (res.statusCode) {
      case 404:
        response = JSON.parse(body);
        msg.send("I couldn't find what you were looking for: " + response.message, done);
        break;
      case 401:
        msg.send('Not authorized. Did you set NESTOR_CIRCLECI_TOKEN correctly?', done);
        break;
      case 500:
        msg.send('Yikes! I turned that circle into a square', done);
        break;
      case 200:
        response = JSON.parse(body);
        handler(response);
        break;
      default:
        msg.send("Hmm.  I don't know how to process that CircleCI response: " + res.statusCode + ": " +  body, done);
    }
  };
};

module.exports = function(robot) {
  robot.respond(/circle me (\S*)\s*(\S*)/i, function(msg, done) {
    var project = escape(toProject(msg.match[1]));
    var branch = msg.match[2] ? escape(msg.match[2]) : 'master';

    robot.http(endpoint + "/project/" + project + "/tree/" + branch + "?circle-token=" + process.env.NESTOR_CIRCLECI_TOKEN).headers({
      "Accept": "application/json"
    }).get()(handleResponse(msg, function(response) {
      var currentBuild;
      if (response.length === 0) {
        msg.send("Current status: " + project + " [" + branch + "]: unknown", done);
      } else {
        currentBuild = response[0];
        msg.send("Current status: " + (formatBuildStatus(currentBuild)), done);
      }
    }, done));
  });

  robot.respond(/circle last (\S*)\s*(\S*)/i, function(msg, done) {
    var project = escape(toProject(msg.match[1]));
    var branch = msg.match[2] ? escape(msg.match[2]) : 'master';

    robot.http(endpoint + "/project/" + project + "/tree/" + branch + "?circle-token=" + process.env.NESTOR_CIRCLECI_TOKEN).headers({
      "Accept": "application/json"
    }).get()(handleResponse(msg, function(response) {
      var last;
      if (response.length === 0) {
        msg.send("Current status: " + project + " [" + branch + "]: unknown", done);
      } else {
        last = response[0];
        if (last.status !== 'running') {
          msg.send("Current status: " + (formatBuildStatus(last)), done);
        } else if (last.previous && last.previous.status) {
          msg.send("Last status: " + (formatBuildStatus(last)), done);
        } else {
          msg.send("Last build status for " + project + " [" + branch + "]: unknown", done);
        }
      }
    }));
  });

  robot.respond(/circle retry (.*) (.*)/i, function(msg, done) {
    var project = escape(toProject(msg.match[1]));
    var build_num = escape(msg.match[2]);

    if (build_num === 'last') {
      var branch = 'master';
      robot.http(endpoint + "/project/" + project + "/tree/" + branch + "?circle-token=" + process.env.NESTOR_CIRCLECI_TOKEN).headers({
        "Accept": "application/json"
      }).get()(handleResponse(msg, function(response) {
        var last = response[0];
        build_num = last.build_num;
        retryBuild(robot, msg, endpoint, project, build_num, done);
      }));
    } else {
      retryBuild(robot, msg, endpoint, project, build_num, done);
    }
  });

  robot.respond(/circle list (.*)/i, function(msg, done) {
    var status = escape(msg.match[1]);
    if (status !== 'failed' && status !== 'success') {
      msg.send("Status can only be failed or success.", done);
      return;
    }
    getProjectsByStatus(robot, msg, endpoint, status, 'list', done);
  });

  robot.respond(/circle cancel (.*) (.*)/i, function(msg, done) {
    var project = escape(toProject(msg.match[1]));
    if (msg.match[2] === null) {
      msg.send("I can't cancel without a build number", done);
    } else {
      var build_num = escape(msg.match[2]);

      robot.http(endpoint + "/project/" + project + "/" + build_num + "/cancel?circle-token=" + process.env.NESTOR_CIRCLECI_TOKEN).headers({
        "Accept": "application/json"
      }).post('{}')(handleResponse(msg, function(response) {
        msg.send("Canceled build " + response.build_num + " for " + project + " [" + response.branch + "]", done);
      }));
    }
  });

  robot.respond(/circle clear (.*)/i, function(msg, done) {
    var project = escape(toProject(msg.match[1]));
    clearProjectCache(msg, endpoint, project, done);
  });
};
