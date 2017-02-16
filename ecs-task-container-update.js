/**
 * @file
 * Updates a container with a an ECS task definition
 * based on the DeployParams created from the provided event;
 * Optionally updates a service also which will
 * trigger a rolling deploy of the new version
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
 * @module ecs-task-container-update
 *
 * @license Apache-2.0
 */

var AWS = require('aws-sdk');
var ecs = new AWS.ECS();

/**
 * Parameter object to represent known data.
 * This exists primarily for documentation purposes rather than
 * enforcing constraints as this is not exposed outside of this
 * script.
 */
var DeployParams = (() => {
    var requiredParams = [
        'taskFamily',
        'containerName',
        'imageBase'];

    /**
     * @class DeployParams
     * @global
     * @param {Object} event - Input object containing all non-optional fields
     * @property {String} [cluster=default] - Cluster to update
     * @property {String} service - Service to update
     * @property {String} taskFamily - Task family to update
     * @property {String} containerName - Container name within task to update
     * @property {String} imageBase - Image name or repository URI
     * @property {String} [imageTag=latest] - Tag to use for image
     *
     * @throws {String[]} Validation errors for invalid arguments
     */
    return function(event) {
        var errors = requiredParams
            .map(it => event[it] ? null : it + " is required.")
            .filter(it => it);
        if (errors.length > 0) throw errors;

        this.imageBase = event.imageBase;
        this.imageTag = event.imageTag || 'latest';
        this.image = this.imageBase+":"+this.imageTag;

        this.taskFamily = event.taskFamily;
        this.containerName = event.containerName;

        if (event.cluster && !event.service)
            throw ["service is required when cluster is specified"];
        this.cluster = event.cluster || 'default';
        this.service = event.service;
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
    console.log("Beginning deployment for event:",
                JSON.stringify(event, null, 2));

    var p;
    try {
        p = new DeployParams(event);
    } catch (e) {
        return callback(e);
    }

    return buildPromise(p)
        .then(callback.bind(null, null))
        .catch(callback);
};

/**
 * Build an appropriate Promise chain depending on
 * whether performing a Task update only or also
 * updating a Service (based on DeployParams.
 *
 * @returns {Promise} constructed promise
 * @param {DeployParams} p - execution parameters
 */
var buildPromise = function(p) {
    var taskUpdate = describeTask(p)
        .then(updateTask.bind(null, p));
    return !(p.service) ? taskUpdate
        : taskUpdate.then(updateService.bind(null, p));
}

/**
 * Retrieves existing Task referenced in {@link DeployParams}.
 * Used to clone any existing un-changing data.
 *
 * @returns {Promise} Result of ecs#describeTaskDefinition which
 * provides target task for updating
 * @param {DeployParams} p - Execution parameters
 * @param {Object} result - Payload from ecs#describeServices
 * @private
 */
var describeTask = function(p) {
    return ecs.describeTaskDefinition({
        taskDefinition: p.taskFamily}).promise();
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
