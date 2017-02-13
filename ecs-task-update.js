/**
 * @file
 * Updates a task definition within an ECS cluster based on the
 * DeployParams created from the provided event;
 * triggers a rolling deploy of the new version.
 *
 * This could be called directly or respond to an event such as an
 * SNS notification sent by a CI server.
 *
 * The end result is an update to an individual container definition
 * with new image information. The arguments locate the container
 * definition by <i>cluster/service/taskDefinition/containerName</i>
 * and update that container to use the image <i>imageBase:imageTag</i>
 * Each of the arguments are represented as simple strings but
 * conceptually map to the two structures outlined
 *
 * This logic depends on access to the following IAM actions:
 * <ul>
 * <li>ecs:DescribeTaskDefinition</li>
 * <li>ecs:DescribeServices</li>
 * <li>ecs:RegisterTaskDefinition</li>
 * <li>ecs:UpdateService</li>
 * </ul>
 *
 * @module ecs-task-update
 * @todo replace zip stuff with a more node-y solution
 * @todo Write tests
 * @todo Audit logic...update task directly and then update
 * service more intentionally
 *
 */

//I'm not crazy about the current logic
//may want to shuffle things around a bit after it's known to work
var AWS = require('aws-sdk');
var ecs = new AWS.ECS();

/**
 * Parameter object to represent known data.
 * This exists primarily for documentation purposes rather than
 * enforcing constraints as this is not exposed outside of this
 * script.
 *
 */
var DeployParams = (() => {
    var requiredParams = [
        'service',
        'taskDefinition',
        'containerName',
        'imageBase'];
    /**
     * @class DeployParams
     * @global
     * @param {Object} event - Input object containing all non-optional fields
     * @property {String} [cluster=default] - Cluster to update
     * @property {String} service - Service to update
     * @property {String} taskDefinition - Task to update
     * @property {String} containerName - Container name within task to update
     * @property {String} imageBase - Image name or repository URI
     * @property {String} [imageTag=latest] - Tag to use for image
     *
     * @throws {String[]} Validation errors for invalid arguments
     *
     * @todo use class keyword?
     */
    return function(event) {
        var errors = requiredParams
            .map(it => event[it] ? null : it + " is required.")
            .filter(it => it);
        if (errors.length > 0) throw errors;

        this.cluster = event.cluster || 'default';
        this.service = event.service;
        this.taskDefinition = event.taskDefinition;
        this.containerName = event.containerName;
        this.imageBase = event.imageBase;
        this.imageTag = event.imageTag || 'latest';
        this.image = this.imageBase+":"+this.imageTag;
    };
})();

/**
 * @callback lambdaCallback
 * @param {Object} error - Error to indicate failure if present
 * @param {Object} success - Successful response to return if error is null
 */

/**
 * Handler which will perform the update based on a
 * {@link DeployParams} instance generated from the passed event.
 * See the documented parameters for {@link DeployParams} for
 * information about event fields.
 *
 * @returns {Promise} ending Promise from execution of complete chain
 * @param {Object} event - Input event to be parsed into a {@link DeployParams}
 * @param {Object} context - Lambda context, presently unused
 * @param {lambdaCallback} callback - Lambda callback
 */
exports.handler = function(event, context, callback) {
    var p;
    try {
        p = new DeployParams(event);
    } catch (e) {
        return callback(e);
    }

    console.log("Beginning deployment for event:",
                JSON.stringify(event, null, 2));

    return promised(callback, describeService(p)
                    .then(describeTask.bind(null, p))
                    .then(updateTask.bind(null, p))
                    .then(updateService.bind(null, p)));
};

/**
 * Describes service defined by {@link DeployParams}
 *
 * @returns {Promise} Result of ecs#describeServices to be used for
 * further introspection
 * @param {DeployParams} p - Execution parameters
 * @private
 */
var describeService = function(p) {
    return ecs.describeServices({cluster: p.cluster,
                                 services: [p.service]}).promise();
};

/**
 * Describes task from result of {@link describeService} based on
 * {@link DeployParams}
 *
 * @returns {Promise} Result of ecs#describeTaskDefinition which
 * provides target task for updating
 * @param {DeployParams} p - Execution parameters
 * @param {Object} result - Payload from ecs#describeServices
 * @private
 * @todo use the task in p rather than just blindly grabbing the first
 */
var describeTask = function(p, result) {
    return ecs.describeTaskDefinition({
        taskDefinition: result.services[0].taskDefinition}).promise();
};

/**
 * Creates function which transforms containers: updating
 * any with a name matching toMatch to have the new name newImage
 * and returning others untouched (for use in #map).
 *
 * @returns {Function} A function which transforms a container
 * @param {String} toMatch - A container name which predicates a name
 * update
 * @param {String} newImage - The new image name to set when toMatch
 * matches
 * @private
 */
var containerTransformer = function(toMatch, newImage) {
    return function(container) {
        if (container.name === toMatch) container.image = newImage;
        return container;
    };
};

/**
 * Updates the task from {@link describeTask} based on
 * {@link DeployParams}
 *
 * @returns {Promise} Result of ecs#registerTaskDefinition which
 * represents newly updated task
 * @param {DeployParams} - Execution parameters
 * @param {Object} - Payload from ecs#describeTask
 * @private
 */
var updateTask = function(p, result) {
    var task = result.taskDefinition;
    console.log("Updating task:" + JSON.stringify(task));
    return ecs.registerTaskDefinition({
        family: task.family,
        volumes: task.volumes,
        taskRoleArn: task.taskRoleArn,
        containerDefinitions: task.containerDefinitions
            .map(containerTransformer(p.containerName, p.image))
    }).promise();
};

/**
 * Updates the service specified by {@link DeployParams}
 * to use the task updated in {@link updateTask}
 *
 * @returns {Promise} Result of ecs#updateService which represents
 * completion of this flow
 * @param {DeployParams} p - Execution parameters
 * @param {Object} result - Payload from ecs#registerTaskDefinition
 * @private
 */
var updateService = function(p, result) {
    var task = result.taskDefinition;
    console.log("New task:" + JSON.stringify(task));
    return ecs.updateService({
        cluster: p.cluster,
        service: p.service,
        taskDefinition: task.taskDefinitionArn
    }).promise();
};

/**
 * Adapt promise to work with callback...keeps noise out of the flow
 *
 * @returns {undefined} A whole lotta nothin'
 * @param {Function} callback - Callback to call on promise resolution
 * @param {Promise} promise - Promise to adapt to callback
 * @private
 */
var promised = function(callback, promise) {
    promise.then(callback.bind(null, null))
        .catch(callback);
};
