targetScope = 'subscription'

@minLength(1)
@maxLength(64)
param environmentName string

param location string = deployment().location

@secure()
param adminPassword string

@secure()
param databaseUrl string = ''

var normalizedEnvironmentName = toLower(replace(environmentName, '_', '-'))
var tags = {
  'azd-env-name': environmentName
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${normalizedEnvironmentName}'
  location: location
  tags: tags
}

module resources './modules/resources.bicep' = {
  name: 'quiz-app-resources'
  scope: resourceGroup
  params: {
    adminPassword: adminPassword
    databaseUrl: databaseUrl
    name: normalizedEnvironmentName
    location: location
    tags: tags
  }
}

output AZURE_RESOURCE_GROUP string = resourceGroup.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.containerRegistryEndpoint
output WEB_URL string = resources.outputs.webUrl
