var url = require('url');
var util = require('util');
var querystring = require('querystring');
var circleciHost = process.env.NESTOR_CIRCLECI_HOST ? process.env.NESTOR_CIRCLECI_HOST : "circleci.com";
var endpoint = "https://" + circleciHost + "/api/v1";

var toProject = function(project) {
  if (project.indexOf("/") === -1 && (process.env.NESTOR_GITHUB_ORG != null)) {
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

var retryBuild = function(msg, endpoint, project, build_num) {
  msg.http(endpoint + "/project/" + project + "/" + build_num + "/retry?circle-token=" + process.env.NESTOR_CIRCLECI_TOKEN).headers({
    "Accept": "application/json"
  }).post('{}')(handleResponse(msg, function(response) {
    return msg.send("Retrying build " + build_num + " of " + project + " [" + response.branch + "] with build " + response.build_num);
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
      listProjectsByStatus(robot, msg, projects, status, done);
    } else if (action === 'retry') {
      retryProjectsByStatus(robot, msg, projects, status, done);
    }
  }));
};

var retryProjectsByStatus = function(robot, msg, projects, status, done) {
  var build_branch, i, last_build, len, project, results;
  results = [];
  for (i = 0, len = projects.length; i < len; i++) {
    project = projects[i];
    build_branch = project.branches[project.default_branch];
    last_build = build_branch.recent_builds[0];
    project = toProject(project.reponame);
    results.push(retryBuild(msg, endpoint, project, last_build.build_num));
  }
  return results;
};

var listProjectsByStatus = function(msg, projects, status) {
  var build_branch, i, last_build, len, message, project;
  if (projects.length === 0) {
    return msg.send("No projects match status " + status);
  } else {
    message = "Projects where the last build's status is " + status + ":\n";
    for (i = 0, len = projects.length; i < len; i++) {
      project = projects[i];
      build_branch = project.branches[project.default_branch];
      last_build = build_branch.recent_builds[0];
      message = message + ((toDisplay(last_build.outcome)) + " in build https://circleci.com/gh/" + project.username + "/" + project.reponame + "/" + last_build.build_num + " of " + project.vcs_url + " [" + project.default_branch + "]\n");
    }
    return msg.send("" + message);
  }
};

var clearProjectCache = function(msg, endpoint, project) {
  return msg.http(endpoint + "/project/" + project + "/build-cache?circle-token=" + process.env.NESTOR_CIRCLECI_TOKEN).headers({
    "Accept": "application/json"
  }).del('{}')(handleResponse(msg, function(response) {
    return msg.send("Cleared build cache for " + project);
  }));
};

var clearAllProjectsCache = function(msg, endpoint) {
  return msg.http(endpoint + "/projects?circle-token=" + process.env.NESTOR_CIRCLECI_TOKEN).headers({
    "Accept": "application/json"
  }).get()(handleResponse(msg, function(response) {
    var i, len, project, projectname, results;
    results = [];
    for (i = 0, len = response.length; i < len; i++) {
      project = response[i];
      projectname = escape(toProject(project.reponame));
      results.push(clearProjectCache(msg, endpoint, projectname));
    }
    return results;
  }));
};

var handleResponse = function(msg, handler) {
  return function(err, res, body) {
    var response;
    if (err != null) {
      msg.send("Something went really wrong: " + err);
    }
    switch (res.statusCode) {
      case 404:
        response = JSON.parse(body);
        return msg.send("I couldn't find what you were looking for: " + response.message);
      case 401:
        return msg.send('Not authorized. Did you set NESTOR_CIRCLECI_TOKEN correctly?');
      case 500:
        return msg.send('Yikes! I turned that circle into a square');
      case 200:
        response = JSON.parse(body);
        return handler(response);
      default:
        return msg.send("Hmm.  I don't know how to process that CircleCI response: " + res.statusCode, body);
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
    }));
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
    var branch, build_num, project, status;

    if (msg.match[1] === 'all') {
      status = escape(msg.match[2]);
      getProjectsByStatus(msg, endpoint, status, 'retry', done);
    } else {
      project = escape(toProject(msg.match[1]));
    }

    build_num = escape(msg.match[2]);
    if (build_num === 'last') {
      branch = 'master';
      return msg.http(endpoint + "/project/" + project + "/tree/" + branch + "?circle-token=" + process.env.NESTOR_CIRCLECI_TOKEN).headers({
        "Accept": "application/json"
      }).get()(handleResponse(msg, function(response) {
        var last;
        last = response[0];
        build_num = last.build_num;
        return retryBuild(msg, endpoint, project, build_num);
      }));
    } else {
      return retryBuild(msg, endpoint, project, build_num);
    }
  });

  robot.respond(/circle list (.*)/i, function(msg) {
    var status;
    status = escape(msg.match[1]);
    if (status !== 'failed' && status !== 'success') {
      msg.send("Status can only be failed or success.");
      return;
    }
    return getProjectsByStatus(msg, endpoint, status, 'list');
  });

  robot.respond(/circle cancel (.*) (.*)/i, function(msg) {
    var build_num, project;
    project = escape(toProject(msg.match[1]));
    if (msg.match[2] == null) {
      msg.send("I can't cancel without a build number");
      return;
    }
    build_num = escape(msg.match[2]);
    return msg.http(endpoint + "/project/" + project + "/" + build_num + "/cancel?circle-token=" + process.env.NESTOR_CIRCLECI_TOKEN).headers({
      "Accept": "application/json"
    }).post('{}')(handleResponse(msg, function(response) {
      return msg.send("Canceled build " + response.build_num + " for " + project + " [" + response.branch + "]");
    }));
  });

  robot.respond(/circle clear (.*)/i, function(msg) {
    var project;
    if (msg.match[1] === 'all') {
      return clearAllProjectsCache(msg, endpoint);
    } else {
      project = escape(toProject(msg.match[1]));
      return clearProjectCache(msg, endpoint, project);
    }
  });
};
